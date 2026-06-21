create table customers (
  id integer primary key,
  name text not null
);

create table customer_favorites (
  id integer primary key,
  customer_id integer not null,
  is_active boolean not null
);
