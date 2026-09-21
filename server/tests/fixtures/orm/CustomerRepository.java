package com.example.repo;

import com.example.domain.Customer;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import java.util.List;
import java.util.Optional;

public interface CustomerRepository extends JpaRepository<Customer, Long> {

    List<Customer> findByEmail(String email);

    List<Customer> findByDisplayNameAndTenantId(String displayName, Long tenantId);

    long deleteByEmail(String email);

    @Query("SELECT c FROM Customer c WHERE c.email = :email")
    Optional<Customer> findCustomByEmail(@Param("email") String email);

    @Query("UPDATE Customer c SET c.displayName = :name WHERE c.id = :id")
    int renameCustomer(@Param("id") Long id, @Param("name") String name);

    @Query(value = "SELECT * FROM customers WHERE email_address = ?1", nativeQuery = true)
    Customer findByEmailNative(String email);
}
