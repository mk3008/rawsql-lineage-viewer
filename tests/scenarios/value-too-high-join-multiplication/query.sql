select
  o.customer_id,
  sum(o.total_amount) as total_amount
from orders o
join order_items oi on oi.order_id = o.id
group by o.customer_id;
