package com.example.service;

import com.example.mapper.BarMapper;

public class BarService {

    private BarMapper barMapper;

    public Bar getBar(long id) {
        return barMapper.findById(id);
    }
}
