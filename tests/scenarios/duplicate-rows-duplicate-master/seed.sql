insert into customers (id, name) values
  (10, 'Alice');

insert into customer_tags (id, customer_id, tag, is_active) values
  (1, 10, 'vip', true),
  (2, 10, 'priority', true);
