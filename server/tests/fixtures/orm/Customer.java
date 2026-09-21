package com.example.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import jakarta.persistence.Id;
import jakarta.persistence.Column;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.OneToMany;
import jakarta.persistence.Transient;
import java.util.List;

@Entity
@Table(name = "customers", schema = "crm")
public class Customer {

    @Id
    private Long id;

    @Column(name = "email_address")
    private String email;

    private String displayName;

    @ManyToOne
    @JoinColumn(name = "tenant_id")
    private Tenant tenant;

    @OneToMany(mappedBy = "customer")
    private List<Order> orders;

    @Transient
    private String fullName;
}
