select
  o.customer_id,
  sum(o.total_amount) as total_amount
from orders o
group by o.customer_id
order by o.customer_id;
