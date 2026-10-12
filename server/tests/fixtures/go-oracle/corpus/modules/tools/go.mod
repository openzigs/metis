module example.com/tools

go 1.22

require example.com/app v0.0.0

require example.net/acme/queue v0.0.0 // indirect

replace example.com/app => ../app

replace example.net/acme/queue => ../../../thirdparty/queue
