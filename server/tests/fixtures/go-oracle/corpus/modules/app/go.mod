module example.com/app

go 1.22

require example.net/acme/queue v0.0.0

replace example.net/acme/queue => ../../../thirdparty/queue
