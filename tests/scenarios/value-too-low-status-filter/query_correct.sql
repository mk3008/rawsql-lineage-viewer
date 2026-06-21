select
  p.customer_id,
  sum(p.amount) as paid_amount
from payments p
where p.status = 'success'
group by p.customer_id
order by p.customer_id;
