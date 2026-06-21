create table orders (
  id integer primary key,
  customer_id integer not null,
  total_amount numeric not null
);

create table order_items (
  id integer primary key,
  order_id integer not null references orders(id),
  product_name text not null
);
