select
  p.customer_id,
  coalesce(sum(p.amount), 0) as paid_amount
from payments p
where p.status = 'succeeded'
group by p.customer_id;
