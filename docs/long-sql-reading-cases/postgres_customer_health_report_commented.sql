/*
  PostgreSQL SELECT-only sample query for parser / lineage / readability tests.
  Scenario: monthly B2B SaaS customer health report.
  The schema is fictional, but the shape is intentionally close to real operations.
*/
WITH
-- Defines report windows and reusable filters so every downstream CTE uses the same boundaries.
params AS (
    SELECT
        DATE '2026-05-01' AS report_from, DATE '2026-06-01' AS report_to,
        DATE '2026-04-01' AS previous_from, DATE '2026-05-01' AS previous_to,
        90::integer AS dormant_days, ARRAY['active', 'trialing', 'past_due']::text[] AS included_statuses,
        ARRAY['enterprise', 'business', 'pro']::text[] AS included_plan_tiers
),
-- Selects the customer population for the report: non-deleted, included statuses, created before report end.
target_customers AS (
    SELECT
        c.id AS customer_id, c.account_code,
        c.legal_name, c.display_name,
        c.status AS customer_status, c.segment,
        c.industry, c.country_code,
        c.region_code, c.sales_channel,
        c.billing_currency, c.default_payment_terms_days,
        c.created_at FROM crm.customers c
    CROSS JOIN params p WHERE c.deleted_at IS NULL
      AND c.status = ANY (p.included_statuses) AND c.created_at < p.report_to
),
-- Finds the latest status history row per target customer before the report end timestamp.
latest_status AS (
    SELECT
        x.customer_id, x.status AS latest_status,
        x.status_reason, x.changed_at AS latest_status_changed_at,
        x.changed_by_user_id FROM (
        SELECT
            h.customer_id, h.status,
            h.status_reason, h.changed_at,
            -- Window rank keeps only the newest status row; id is used as a deterministic tie-breaker.
            h.changed_by_user_id, ROW_NUMBER() OVER (
                PARTITION BY h.customer_id ORDER BY h.changed_at DESC, h.id DESC
            ) AS rn FROM crm.customer_status_history h
        JOIN target_customers tc ON tc.customer_id = h.customer_id CROSS JOIN params p
        WHERE h.changed_at < p.report_to ) x
    WHERE x.rn = 1
),
-- Resolves the current account owner, customer success owner, and primary contact for each target customer.
contact_snapshot AS (
    SELECT
        tc.customer_id, owner_user.email AS account_owner_email,
        owner_user.display_name AS account_owner_name, success_user.email AS customer_success_email,
        success_user.display_name AS customer_success_name, primary_contact.email AS primary_contact_email,
        primary_contact.full_name AS primary_contact_name FROM target_customers tc
    -- LATERAL subquery chooses the currently active account owner for this customer.
    LEFT JOIN LATERAL ( SELECT u.email, u.display_name
        FROM crm.customer_assignments a JOIN iam.users u ON u.id = a.user_id
        WHERE a.customer_id = tc.customer_id AND a.role_code = 'account_owner'
          AND a.started_at <= CURRENT_TIMESTAMP AND COALESCE(a.ended_at, CURRENT_TIMESTAMP + INTERVAL '1 day') > CURRENT_TIMESTAMP
        ORDER BY a.started_at DESC, a.id DESC LIMIT 1
    ) owner_user ON TRUE
    -- LATERAL subquery chooses the currently active customer success owner for this customer.
    LEFT JOIN LATERAL (
        SELECT u.email, u.display_name FROM crm.customer_assignments a
        JOIN iam.users u ON u.id = a.user_id WHERE a.customer_id = tc.customer_id
          AND a.role_code = 'customer_success' AND a.started_at <= CURRENT_TIMESTAMP
          AND COALESCE(a.ended_at, CURRENT_TIMESTAMP + INTERVAL '1 day') > CURRENT_TIMESTAMP ORDER BY a.started_at DESC, a.id DESC
        LIMIT 1 ) success_user ON TRUE
    -- LATERAL subquery chooses the best primary contact, preferring verified and recently updated records.
    LEFT JOIN LATERAL ( SELECT cp.email, cp.full_name
        FROM crm.contact_points cp WHERE cp.customer_id = tc.customer_id
          AND cp.is_primary = TRUE AND cp.deleted_at IS NULL
        ORDER BY cp.verified_at DESC NULLS LAST, cp.updated_at DESC LIMIT 1
    ) primary_contact ON TRUE
),
-- Collects in-scope subscriptions and plan attributes whose active interval overlaps the report month.
subscription_snapshot AS (
    SELECT
        s.customer_id, s.id AS subscription_id,
        p.plan_code, p.plan_name,
        p.plan_tier, s.status AS subscription_status,
        s.billing_period, s.quantity AS licensed_seats,
        s.monthly_unit_price, s.discount_percent,
        s.started_at, s.current_period_ends_at,
        s.cancel_at, s.cancelled_at,
        s.trial_ends_at FROM billing.subscriptions s
    JOIN billing.plans p ON p.id = s.plan_id JOIN target_customers tc ON tc.customer_id = s.customer_id
    CROSS JOIN params prm WHERE s.started_at < prm.report_to
      -- Active-interval overlap test: subscriptions cancelled after the month starts still belong to this report.
      AND COALESCE(s.cancelled_at, prm.report_to + INTERVAL '1 day') >= prm.report_from AND p.plan_tier = ANY (prm.included_plan_tiers)
),
-- Aggregates subscription counts, seats, contracted MRR, and subscription drill-down details per customer.
subscription_rollup AS (
    SELECT
        s.customer_id, COUNT(*) FILTER (WHERE s.subscription_status IN ('active', 'trialing', 'past_due')) AS active_subscription_count,
        COUNT(*) FILTER (WHERE s.subscription_status = 'trialing') AS trial_subscription_count,
        COUNT(*) FILTER (WHERE s.cancel_at IS NOT NULL OR s.cancelled_at IS NOT NULL) AS cancellation_count,
        MAX(s.current_period_ends_at) AS latest_current_period_ends_at,
        MIN(s.trial_ends_at) FILTER (WHERE s.trial_ends_at >= CURRENT_TIMESTAMP) AS nearest_trial_ends_at,
        SUM(s.licensed_seats) AS licensed_seat_count,
        -- Contracted MRR applies the per-subscription discount.
        SUM(s.licensed_seats * s.monthly_unit_price * (1 - COALESCE(s.discount_percent, 0) / 100.0)) AS contracted_mrr,
        -- Keep subscription detail JSON for drill-down display.
        jsonb_agg(
            jsonb_build_object( 'subscription_id', s.subscription_id,
                'plan_code', s.plan_code, 'status', s.subscription_status,
                'licensed_seats', s.licensed_seats, 'period_ends_at', s.current_period_ends_at
            ) ORDER BY s.started_at DESC ) AS subscription_details
    FROM subscription_snapshot s GROUP BY s.customer_id
),
-- Collects current-month invoice lines and normalizes revenue recognition for draft/void invoices.
current_invoice_lines AS (
    SELECT
        i.customer_id, i.id AS invoice_id,
        i.invoice_number, i.status AS invoice_status,
        i.issued_at, i.due_at,
        il.id AS invoice_line_id, il.product_code,
        il.description AS line_description, il.quantity,
        il.unit_price, il.discount_amount,
        il.tax_amount, il.amount_excluding_tax,
        il.amount_including_tax,
        -- Draft and void invoices are retained for diagnostics but contribute zero recognized net revenue.
        CASE
            WHEN i.status IN ('void', 'draft') THEN 0::numeric ELSE il.amount_excluding_tax
        END AS recognized_net_amount FROM billing.invoices i
    JOIN billing.invoice_lines il ON il.invoice_id = i.id JOIN target_customers tc ON tc.customer_id = i.customer_id
    CROSS JOIN params p WHERE i.issued_at >= p.report_from
      AND i.issued_at < p.report_to AND il.deleted_at IS NULL
),
-- Aggregates previous-month invoice revenue so month-over-month revenue movement can be calculated later.
previous_invoice_rollup AS (
    SELECT
        i.customer_id, SUM(il.amount_excluding_tax) AS previous_net_revenue,
        SUM(il.amount_including_tax) AS previous_gross_revenue FROM billing.invoices i
    JOIN billing.invoice_lines il ON il.invoice_id = i.id JOIN target_customers tc ON tc.customer_id = i.customer_id
    CROSS JOIN params p WHERE i.issued_at >= p.previous_from
      AND i.issued_at < p.previous_to AND i.status NOT IN ('void', 'draft')
      AND il.deleted_at IS NULL GROUP BY i.customer_id
),
-- Summarizes current-month invoice volume, revenue, discounts, taxes, overdue state, and invoice examples.
invoice_rollup AS (
    SELECT
        cil.customer_id, COUNT(DISTINCT cil.invoice_id) AS current_invoice_count,
        COUNT(*) AS current_invoice_line_count, SUM(cil.recognized_net_amount) AS current_net_revenue,
        SUM(cil.tax_amount) AS current_tax_amount,
        SUM(cil.amount_including_tax) FILTER (WHERE cil.invoice_status NOT IN ('void', 'draft')) AS current_gross_revenue,
        SUM(cil.discount_amount) AS current_discount_amount,
        MIN(cil.due_at) FILTER (WHERE cil.invoice_status IN ('open', 'past_due')) AS oldest_open_due_at,
        COUNT(DISTINCT cil.invoice_id) FILTER (WHERE cil.invoice_status = 'past_due') AS past_due_invoice_count,
        -- Store open/past-due invoice examples as supporting evidence.
        jsonb_agg(
            DISTINCT jsonb_build_object( 'invoice_number', cil.invoice_number,
                'status', cil.invoice_status, 'issued_at', cil.issued_at,
                'due_at', cil.due_at
            ) ) FILTER (WHERE cil.invoice_status IN ('open', 'past_due')) AS open_invoice_examples
    FROM current_invoice_lines cil GROUP BY cil.customer_id
),
-- Summarizes current-month payment outcomes and the most common successful payment method per customer.
payment_rollup AS (
    SELECT
        pay.customer_id, COUNT(*) FILTER (WHERE pay.status = 'succeeded') AS succeeded_payment_count,
        COUNT(*) FILTER (WHERE pay.status = 'failed') AS failed_payment_count,
        SUM(pay.amount) FILTER (WHERE pay.status = 'succeeded') AS paid_amount,
        MAX(pay.received_at) FILTER (WHERE pay.status = 'succeeded') AS latest_payment_received_at,
        MAX(pay.failed_at) FILTER (WHERE pay.status = 'failed') AS latest_payment_failed_at,
        -- PostgreSQL ordered-set aggregate returns the most frequent successful payment method.
        MODE() WITHIN GROUP (ORDER BY pay.method_code) FILTER (WHERE pay.status = 'succeeded') AS most_common_payment_method
    FROM billing.payments pay JOIN target_customers tc ON tc.customer_id = pay.customer_id
    CROSS JOIN params p WHERE COALESCE(pay.received_at, pay.failed_at) >= p.report_from
      AND COALESCE(pay.received_at, pay.failed_at) < p.report_to GROUP BY pay.customer_id
),
-- Aggregates successful current-month refunds so net commercial health can be interpreted with revenue.
refund_rollup AS (
    SELECT
        r.customer_id, COUNT(*) AS refund_count,
        SUM(r.amount) AS refunded_amount, MAX(r.created_at) AS latest_refund_created_at
    FROM billing.refunds r JOIN target_customers tc ON tc.customer_id = r.customer_id
    CROSS JOIN params p WHERE r.status = 'succeeded'
      AND r.created_at >= p.report_from AND r.created_at < p.report_to
    GROUP BY r.customer_id
),
-- Collects external customer product usage events for the report month, excluding internal activity.
usage_events AS (
    SELECT
        e.customer_id, e.user_id,
        e.event_name, e.feature_code,
        e.occurred_at, e.quantity
    FROM product.usage_events e JOIN target_customers tc ON tc.customer_id = e.customer_id
    CROSS JOIN params p WHERE e.occurred_at >= p.report_from
      AND e.occurred_at < p.report_to AND e.is_internal = FALSE
),
-- Converts raw usage events into per-customer, per-day activity metrics used by the monthly rollup.
daily_usage AS (
    SELECT
        ue.customer_id, ue.occurred_at::date AS usage_date,
        COUNT(*) AS event_count, COUNT(DISTINCT ue.user_id) AS active_user_count,
        COUNT(*) FILTER (WHERE ue.event_name = 'login') AS login_count, COUNT(*) FILTER (WHERE ue.event_name = 'export_csv') AS export_count,
        COUNT(*) FILTER (WHERE ue.feature_code = 'workflow_automation') AS automation_event_count,
        -- API events may omit quantity; treat a missing quantity as one request for activity counting.
        SUM(COALESCE(ue.quantity, 1)) FILTER (WHERE ue.feature_code = 'api_request') AS api_request_count FROM usage_events ue
    GROUP BY ue.customer_id, ue.occurred_at::date
),
-- Fills the report-month calendar per customer and aggregates activity, adoption, and recency metrics.
usage_rollup AS (
    SELECT
        tc.customer_id, COUNT(*) FILTER (WHERE du.event_count > 0) AS active_day_count,
        COUNT(*) FILTER (WHERE EXTRACT(ISODOW FROM cal.day) BETWEEN 1 AND 5 AND du.event_count > 0) AS active_business_day_count,
        COALESCE(SUM(du.event_count), 0) AS total_event_count, COALESCE(SUM(du.login_count), 0) AS login_count,
        COALESCE(SUM(du.export_count), 0) AS export_count, COALESCE(SUM(du.automation_event_count), 0) AS automation_event_count,
        COALESCE(SUM(du.api_request_count), 0) AS api_request_count, MAX(du.usage_date) AS latest_usage_date,
        -- Average DAU ignores zero-activity calendar days to avoid diluting actual usage days.
        ROUND((AVG(du.active_user_count) FILTER (WHERE du.event_count > 0))::numeric, 2) AS average_daily_active_users,
        MAX(du.active_user_count) AS peak_daily_active_users FROM target_customers tc
    -- Calendar expansion preserves customers with no usage and enables active-day counts over the full month.
    CROSS JOIN params p CROSS JOIN LATERAL generate_series(p.report_from, p.report_to - INTERVAL '1 day', INTERVAL '1 day') AS cal(day)
    LEFT JOIN daily_usage du ON du.customer_id = tc.customer_id AND du.usage_date = cal.day::date GROUP BY tc.customer_id
),
-- Ranks product features by usage frequency per customer so only the most-used features are exposed later.
feature_rank AS (
    SELECT
        ue.customer_id, ue.feature_code,
        COUNT(*) AS event_count, MAX(ue.occurred_at) AS last_used_at,
        -- Rank by event count, then feature code for stable ordering when counts tie.
        ROW_NUMBER() OVER (PARTITION BY ue.customer_id ORDER BY COUNT(*) DESC, ue.feature_code) AS feature_rank FROM usage_events ue
    WHERE ue.feature_code IS NOT NULL GROUP BY ue.customer_id, ue.feature_code
),
-- Aggregates feature adoption counts and stores the top-used features as JSON detail.
feature_rollup AS (
    SELECT
        fr.customer_id, COUNT(*) AS adopted_feature_count,
        -- Keep only the top-ranked features in the JSON payload while retaining the total adopted-feature count.
        jsonb_agg( jsonb_build_object(
                'feature_code', fr.feature_code, 'event_count', fr.event_count,
                'last_used_at', fr.last_used_at ) ORDER BY fr.event_count DESC, fr.feature_code
        ) FILTER (WHERE fr.feature_rank <= 5) AS top_features FROM feature_rank fr
    GROUP BY fr.customer_id
),
-- Collects support tickets created during the report month and derives response/resolution durations.
support_ticket_base AS (
    SELECT
        t.customer_id, t.id AS ticket_id,
        t.ticket_number, t.priority,
        t.status AS ticket_status, t.category_code,
        t.created_at, t.first_response_at,
        t.resolved_at, t.sla_breached,
        -- Convert response/resolution intervals to hours so later averages are human-readable.
        EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 3600.0 AS first_response_hours,
        EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600.0 AS resolution_hours FROM support.tickets t
    JOIN target_customers tc ON tc.customer_id = t.customer_id CROSS JOIN params p
    WHERE t.created_at >= p.report_from AND t.created_at < p.report_to
      AND t.deleted_at IS NULL
),
-- Aggregates support risk signals such as open tickets, high priority tickets, SLA breaches, and examples.
support_rollup AS (
    SELECT
        stb.customer_id, COUNT(*) AS created_ticket_count,
        COUNT(*) FILTER (WHERE stb.ticket_status IN ('open', 'pending_customer', 'pending_internal')) AS open_ticket_count,
        COUNT(*) FILTER (WHERE stb.priority IN ('urgent', 'high')) AS high_priority_ticket_count,
        COUNT(*) FILTER (WHERE stb.sla_breached = TRUE) AS sla_breached_ticket_count,
        ROUND(AVG(stb.first_response_hours)::numeric, 2) AS average_first_response_hours,
        -- Resolution average only uses tickets that have actually been resolved.
        ROUND((AVG(stb.resolution_hours) FILTER (WHERE stb.resolved_at IS NOT NULL))::numeric, 2) AS average_resolution_hours,
        -- Preserve open ticket examples as evidence for support-risk recommendations.
        jsonb_agg(
            jsonb_build_object( 'ticket_number', stb.ticket_number,
                'priority', stb.priority, 'status', stb.ticket_status,
                'category_code', stb.category_code, 'created_at', stb.created_at
            ) ORDER BY stb.created_at DESC
        ) FILTER (WHERE stb.ticket_status IN ('open', 'pending_customer', 'pending_internal')) AS open_ticket_examples
    FROM support_ticket_base stb GROUP BY stb.customer_id
),
-- Picks the latest NPS response per customer before the report end timestamp.
latest_nps AS (
    SELECT
        x.customer_id, x.score AS latest_nps_score,
        x.comment AS latest_nps_comment, x.responded_at AS latest_nps_responded_at
    FROM ( SELECT
            n.customer_id, n.score,
            n.comment, n.responded_at,
            -- Window rank keeps the latest NPS response; id is used as a deterministic tie-breaker.
            ROW_NUMBER() OVER (PARTITION BY n.customer_id ORDER BY n.responded_at DESC, n.id DESC) AS rn FROM feedback.nps_responses n
        JOIN target_customers tc ON tc.customer_id = n.customer_id CROSS JOIN params p
        WHERE n.responded_at < p.report_to ) x
    WHERE x.rn = 1
),
-- Summarizes recent commercial contract activity and upcoming renewal/end-date signals.
contract_rollup AS (
    SELECT
        ce.customer_id, COUNT(*) FILTER (WHERE ce.event_type = 'renewal') AS renewal_event_count,
        COUNT(*) FILTER (WHERE ce.event_type = 'expansion') AS expansion_event_count,
        COUNT(*) FILTER (WHERE ce.event_type = 'contraction') AS contraction_event_count,
        SUM(ce.amount_delta) FILTER (WHERE ce.event_type = 'expansion') AS expansion_amount,
        SUM(ce.amount_delta) FILTER (WHERE ce.event_type = 'contraction') AS contraction_amount,
        -- Nearest future contract end date drives renewal-attention recommendations.
        MIN(ce.effective_to) FILTER (WHERE ce.effective_to >= CURRENT_DATE) AS nearest_contract_end_date,
        MAX(ce.event_at) AS latest_commercial_event_at FROM sales.contract_events ce
    JOIN target_customers tc ON tc.customer_id = ce.customer_id CROSS JOIN params p
    -- Use a 180-day lookback because commercial context changes more slowly than monthly usage/billing.
    WHERE ce.event_at >= p.report_from - INTERVAL '180 days' AND ce.event_at < p.report_to
    GROUP BY ce.customer_id
),
-- Builds one wide customer-health row by joining customer, billing, usage, support, NPS, and contract metrics.
health_base AS (
    SELECT
        tc.customer_id, tc.account_code,
        tc.legal_name, tc.display_name,
        -- Fall back to the customer master status when no historical status row exists before report end.
        tc.customer_status, COALESCE(ls.latest_status, tc.customer_status) AS latest_status,
        ls.status_reason, tc.segment,
        tc.industry, tc.country_code,
        tc.region_code, tc.sales_channel,
        tc.billing_currency, cs.account_owner_email,
        cs.account_owner_name, cs.customer_success_email,
        cs.customer_success_name, cs.primary_contact_email,
        -- Metric rollups are left joined, so missing facts are normalized to zero for scoring inputs.
        cs.primary_contact_name, COALESCE(sr.active_subscription_count, 0) AS active_subscription_count,
        COALESCE(sr.trial_subscription_count, 0) AS trial_subscription_count, COALESCE(sr.licensed_seat_count, 0) AS licensed_seat_count,
        COALESCE(sr.contracted_mrr, 0) AS contracted_mrr, COALESCE(ir.current_invoice_count, 0) AS current_invoice_count,
        COALESCE(ir.current_net_revenue, 0) AS current_net_revenue, COALESCE(pir.previous_net_revenue, 0) AS previous_net_revenue,
        COALESCE(pr.paid_amount, 0) AS paid_amount, COALESCE(pr.failed_payment_count, 0) AS failed_payment_count,
        COALESCE(rr.refunded_amount, 0) AS refunded_amount, COALESCE(ur.active_business_day_count, 0) AS active_business_day_count,
        COALESCE(ur.total_event_count, 0) AS total_event_count, ur.latest_usage_date,
        COALESCE(fr.adopted_feature_count, 0) AS adopted_feature_count, COALESCE(supr.open_ticket_count, 0) AS open_ticket_count,
        COALESCE(supr.high_priority_ticket_count, 0) AS high_priority_ticket_count,
        COALESCE(supr.sla_breached_ticket_count, 0) AS sla_breached_ticket_count, nps.latest_nps_score,
        nps.latest_nps_comment, cr.nearest_contract_end_date,
        sr.subscription_details, ir.open_invoice_examples,
        fr.top_features, supr.open_ticket_examples
    FROM target_customers tc LEFT JOIN latest_status ls ON ls.customer_id = tc.customer_id
    LEFT JOIN contact_snapshot cs ON cs.customer_id = tc.customer_id LEFT JOIN subscription_rollup sr ON sr.customer_id = tc.customer_id
    LEFT JOIN invoice_rollup ir ON ir.customer_id = tc.customer_id LEFT JOIN previous_invoice_rollup pir ON pir.customer_id = tc.customer_id
    LEFT JOIN payment_rollup pr ON pr.customer_id = tc.customer_id LEFT JOIN refund_rollup rr ON rr.customer_id = tc.customer_id
    LEFT JOIN usage_rollup ur ON ur.customer_id = tc.customer_id LEFT JOIN feature_rollup fr ON fr.customer_id = tc.customer_id
    LEFT JOIN support_rollup supr ON supr.customer_id = tc.customer_id LEFT JOIN latest_nps nps ON nps.customer_id = tc.customer_id
    LEFT JOIN contract_rollup cr ON cr.customer_id = tc.customer_id
),
-- Converts the wide metric row into score inputs: revenue band, growth, recency, NPS bucket, and point totals.
scored AS (
    SELECT
        hb.*,
        -- Revenue band is a simple segmentation derived from contracted MRR.
        CASE
            WHEN hb.contracted_mrr >= 100000 THEN 'strategic' WHEN hb.contracted_mrr >= 30000 THEN 'enterprise'
            WHEN hb.contracted_mrr >= 5000 THEN 'mid_market' ELSE 'long_tail'
        END AS revenue_band,
        -- Month-over-month revenue growth compares recognized current revenue with the previous report month.
        CASE
            -- Avoid division by zero: new revenue is treated as full growth, no revenue as flat zero growth.
            WHEN hb.previous_net_revenue = 0 AND hb.current_net_revenue > 0 THEN 1.0 WHEN hb.previous_net_revenue = 0 THEN 0.0
            ELSE ROUND((hb.current_net_revenue - hb.previous_net_revenue) / NULLIF(hb.previous_net_revenue, 0), 4)
        END AS month_over_month_revenue_growth_rate,
        -- Missing usage receives a high sentinel value so it naturally triggers inactivity risk rules.
        CASE WHEN hb.latest_usage_date IS NULL THEN 999 ELSE CURRENT_DATE - hb.latest_usage_date END AS days_since_last_usage,
        -- Bucket the latest NPS score into common customer-success categories.
        CASE
            WHEN hb.latest_nps_score >= 9 THEN 'promoter'
            WHEN hb.latest_nps_score BETWEEN 7 AND 8 THEN 'passive'
            WHEN hb.latest_nps_score IS NULL THEN 'unknown'
            ELSE 'detractor'
        END AS nps_bucket,
        -- Positive score components reward subscription activity, adoption, satisfaction, payment health, and low support burden.
        (
            CASE WHEN hb.active_subscription_count > 0 THEN 20 ELSE 0 END
          + CASE WHEN hb.active_business_day_count >= 15 THEN 20 ELSE 0 END
          + CASE WHEN hb.adopted_feature_count >= 5 THEN 15 ELSE 0 END
          + CASE WHEN hb.latest_nps_score >= 9 THEN 15 ELSE 0 END
          + CASE WHEN hb.failed_payment_count = 0 THEN 10 ELSE 0 END
          + CASE WHEN hb.sla_breached_ticket_count = 0 THEN 10 ELSE 0 END
          + CASE WHEN hb.open_ticket_count <= 2 THEN 10 ELSE 0 END
        ) AS positive_health_points,
        -- Negative score components penalize payment failures, support load, detractor NPS, and missing usage.
        (
            CASE WHEN hb.failed_payment_count >= 2 THEN 20 ELSE 0 END
          + CASE WHEN hb.open_ticket_count >= 5 THEN 15 ELSE 0 END
          + CASE WHEN hb.high_priority_ticket_count >= 2 THEN 15 ELSE 0 END
          + CASE WHEN hb.latest_nps_score <= 6 THEN 20 ELSE 0 END
          + CASE WHEN hb.latest_usage_date IS NULL THEN 20 ELSE 0 END
        ) AS negative_health_points
    FROM health_base hb
),
-- Produces final health score, recommended attention type, and compact JSON drill-down payload.
final_report AS (
    SELECT
        s.*,
        -- Clamp the raw point difference into a dashboard-friendly 0-100 health score.
        GREATEST(0, LEAST(100, s.positive_health_points - s.negative_health_points)) AS customer_health_score,
        -- Priority order matters: billing issues outrank relationship/support/adoption/renewal signals.
        CASE
            WHEN s.latest_status = 'past_due' THEN 'billing_attention'
            WHEN s.failed_payment_count >= 2 THEN 'billing_attention'
            WHEN s.latest_nps_score <= 6 THEN 'relationship_risk'
            WHEN s.open_ticket_count >= 5 THEN 'support_risk'
            WHEN s.days_since_last_usage >= 30 THEN 'adoption_risk'
            WHEN s.nearest_contract_end_date <= CURRENT_DATE + INTERVAL '60 days' THEN 'renewal_attention'
            ELSE 'normal'
        END AS recommended_attention_type,
        -- Compact supporting evidence for UI drill-down or API consumers.
        jsonb_build_object(
            'subscriptions', COALESCE(s.subscription_details, '[]'::jsonb),
            'open_invoices', COALESCE(s.open_invoice_examples, '[]'::jsonb),
            'top_features', COALESCE(s.top_features, '[]'::jsonb),
            'open_tickets', COALESCE(s.open_ticket_examples, '[]'::jsonb)
        ) AS detail_payload
    FROM scored s
)
-- Final projection: expose report columns, round monetary values, and sort riskiest customers first.
SELECT
    fr.customer_id,
    fr.account_code,
    fr.legal_name,
    fr.display_name,
    fr.customer_status,
    fr.latest_status,
    fr.status_reason,
    fr.segment,
    fr.industry,
    fr.country_code,
    fr.region_code,
    fr.sales_channel,
    fr.billing_currency,
    fr.account_owner_email,
    fr.account_owner_name,
    fr.customer_success_email,
    fr.customer_success_name,
    fr.primary_contact_email,
    fr.primary_contact_name,
    fr.revenue_band,
    fr.active_subscription_count,
    fr.trial_subscription_count,
    fr.licensed_seat_count,
    ROUND(fr.contracted_mrr, 2) AS contracted_mrr,
    fr.current_invoice_count,
    ROUND(fr.current_net_revenue, 2) AS current_net_revenue,
    ROUND(fr.previous_net_revenue, 2) AS previous_net_revenue,
    fr.month_over_month_revenue_growth_rate,
    ROUND(fr.paid_amount, 2) AS paid_amount,
    ROUND(fr.refunded_amount, 2) AS refunded_amount,
    fr.failed_payment_count,
    fr.active_business_day_count,
    fr.total_event_count,
    fr.latest_usage_date,
    fr.days_since_last_usage,
    fr.adopted_feature_count,
    fr.open_ticket_count,
    fr.high_priority_ticket_count,
    fr.sla_breached_ticket_count,
    fr.latest_nps_score,
    fr.nps_bucket,
    fr.latest_nps_comment,
    fr.nearest_contract_end_date,
    fr.customer_health_score,
    fr.recommended_attention_type,
    fr.detail_payload
FROM final_report fr
ORDER BY
    fr.customer_health_score ASC,
    fr.contracted_mrr DESC,
    fr.account_code ASC;
