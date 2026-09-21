package com.acme.service;

import com.acme.FooMapper;

public class FooService {

    private FooMapper fooMapper;

    public Account getAccount(long id) {
        return fooMapper.findAccount(id);
    }
}
