select
  c.id,
  c.name,
  ct.tag
from customers c
join customer_tags ct on ct.customer_id = c.id
where ct.is_active = true;
