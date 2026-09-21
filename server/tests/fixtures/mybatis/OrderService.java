package com.example.service;

import com.example.mapper.OrderMapper;

public class OrderService {

    private OrderMapper orderMapper;

    public Order getOrder(long id) {
        return orderMapper.findById(id);
    }
}
