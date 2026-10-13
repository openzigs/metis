package model

func viaList(l List) {
	l[0].Run()
}

func viaLists(l Lists) {
	l[0].Stop()
}

func viaIndex(idx Index) {
	idx["k"].Run()
	for key, v := range idx {
		_ = key
		v.Stop()
	}
}

func viaFeed(f Feed) {
	(<-f).Run()
	for v := range f {
		v.Stop()
	}
}

func viaVars() {
	Default.Run()
	Shared.Stop()
	Pool[0].Run()
	Spare.Stop()
	First.Run()
	Second.Hello()
	Factory().Run()
}

func viaMethods(t Thing, p *Thing) {
	t.Run()
	p.Run()
	t.Stop()
	p.Stop()
	run := t.Run
	run()
	stop := (*Thing).Stop
	stop(p)
	Thing.Run(t)
	Alias.Run(t)
}

func viaInterface(r Runner) {
	r.Run()
	New().Run()
	Anon().Run()
}
