select p.customer_id, coalesce(sum(p.amount), 0) as paid_amount from payments p where p.status = :status group by p.customer_id;
