select distinct c.id, c.name from customers c join customer_tags ct on ct.customer_id=c.id where ct.is_active=true;
