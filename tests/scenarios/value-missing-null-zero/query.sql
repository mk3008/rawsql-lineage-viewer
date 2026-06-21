with payment_summary as (
  select
    p.customer_id,
    sum(p.amount) as paid_amount
  from payments p
  where p.status = 'succeeded'
  group by p.customer_id
)
select
  c.id as customer_id,
  coalesce(ps.paid_amount, 0) as paid_amount
from customers c
left join payment_summary ps on ps.customer_id = c.id;
