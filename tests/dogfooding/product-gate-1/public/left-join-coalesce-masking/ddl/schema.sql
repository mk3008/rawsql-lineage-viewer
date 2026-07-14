create table customers (id integer primary key, name text not null); create table payments (id integer primary key, customer_id integer not null, amount numeric not null, status text not null);
