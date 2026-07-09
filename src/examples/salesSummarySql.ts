export const salesSummarySql = `WITH
-- Customer scope is intentionally simple so safe condition placement can move
-- customer filters from the final SELECT into this CTE.
customer_scope AS (
  SELECT
    c.id,
    c.name,
    c.email,
    c.region,
    c.status
  FROM customers c
),
-- Recent order line items used as the base sales fact.
recent_orders AS (
  SELECT
    o.id AS order_id,
    o.customer_id,
    o.order_date,
    oi.product_id,
    oi.quantity,
    oi.unit_price,
    oi.quantity * oi.unit_price AS amount -- Extended line amount.
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE o.order_date >= :from_date
    AND o.order_date < :to_date
),
-- Aggregates order metrics by customer.
order_totals AS (
  SELECT
    customer_id,
    COUNT(*) AS order_count,
    SUM(amount) AS total_amount -- Total ordered amount per customer.
  FROM recent_orders
  GROUP BY customer_id
),
-- Captures succeeded payment totals by customer.
payment_summary AS (
  SELECT
    p.customer_id,
    SUM(p.amount) AS paid_amount,
    MAX(p.paid_at) AS last_paid_at
  FROM payments p
  WHERE p.status = 'succeeded'
  GROUP BY p.customer_id
)
SELECT
  cs.id AS customer_id,
  cs.name AS customer_name,
  cs.email,
  COALESCE(ot.order_count, 0) AS order_count,
  COALESCE(ot.total_amount, 0) AS total_amount,
  COALESCE(ps.paid_amount, 0) AS paid_amount,
  CASE
    WHEN ps.last_paid_at IS NULL THEN 'unknown'
    WHEN ps.last_paid_at < CURRENT_DATE - INTERVAL '30 days' THEN 'needs_followup'
    ELSE 'active'
  END AS payment_status
FROM customer_scope cs
LEFT JOIN order_totals ot ON ot.customer_id = cs.id
LEFT JOIN payment_summary ps ON ps.customer_id = cs.id
WHERE cs.id = :customer_id
  AND cs.region = :region
  AND cs.status = :customer_status
  AND EXISTS (
    SELECT 1
    FROM customer_favorites cf
    WHERE cf.customer_id = cs.id
      AND cf.is_active = TRUE
  )
ORDER BY total_amount DESC
LIMIT 100;`;
