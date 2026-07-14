create table orders (id integer primary key, customer_id integer not null); create table order_items (id integer primary key, order_id integer not null, amount numeric not null);
