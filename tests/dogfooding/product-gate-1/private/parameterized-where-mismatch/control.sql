select customer_id, sum(amount) as paid_amount from payments where status = 'success' group by customer_id;
