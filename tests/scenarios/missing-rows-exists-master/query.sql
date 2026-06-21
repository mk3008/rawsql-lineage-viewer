select
  c.id,
  c.name
from customers c
where exists (
  select 1
  from customer_favorites cf
  where cf.customer_id = c.id
    and cf.is_active = true
);
