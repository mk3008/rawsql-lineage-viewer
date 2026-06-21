create table customers (
  id integer primary key,
  name text not null
);

create table customer_tags (
  id integer primary key,
  customer_id integer not null,
  tag text not null,
  is_active boolean not null
);
