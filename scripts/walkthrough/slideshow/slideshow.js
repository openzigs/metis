/* METIS walkthrough slideshow navigation (Issue #829).
 *
 * The slides are static HTML rendered by scripts/lib/walkthrough-slideshow-core.mjs; this script
 * only moves between them. It builds every new node from textContent (never by parsing markup)
 * and registers listeners with addEventListener, so the deck's Content Security Policy needs no
 * 'unsafe-inline'. This file must never contain a closing
 * script tag: the build inlines it for --inline-images.
 */
(function () {
  "use strict";

  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  if (slides.length === 0) return;

  var deck = document.querySelector(".deck");
  var fill = document.querySelector(".progress__fill");
  var progress = document.querySelector(".progress");
  var counter = document.querySelector(".counter");
  var overlay = document.querySelector(".overlay");
  var list = document.querySelector(".overlay__list");
  var lightbox = document.querySelector(".lightbox");
  var lightboxImg = document.querySelector(".lightbox__img");
  var notesButton = document.querySelector('[data-action="notes"]');
  var current = 0;
  var lastFocus = null;
  var THEME_KEY = "metis-slideshow-theme";

  function readHash() {
    var n = parseInt(window.location.hash.replace(/^#\/?/, ""), 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n - 1, 0), slides.length - 1);
  }

  function show(index, updateHash) {
    current = Math.min(Math.max(index, 0), slides.length - 1);
    slides.forEach(function (slide, i) {
      slide.classList.toggle("is-active", i === current);
      slide.classList.toggle("is-before", i < current);
      slide.setAttribute("aria-hidden", i === current ? "false" : "true");
      if ("inert" in slide) slide.inert = i !== current;
    });
    fill.style.width = (slides.length === 1 ? 100 : (current / (slides.length - 1)) * 100) + "%";
    counter.textContent = current + 1 + " / " + slides.length;
    Array.prototype.forEach.call(list.querySelectorAll("a"), function (a, i) {
      a.setAttribute("aria-current", i === current ? "true" : "false");
    });
    if (updateHash !== false && readHash() !== current) {
      history.replaceState(null, "", "#" + (current + 1));
    }
  }

  function go(delta) {
    show(current + delta);
  }

  // ---- Slide index overlay --------------------------------------------------------------
  slides.forEach(function (slide, i) {
    var li = document.createElement("li");
    var a = document.createElement("a");
    a.href = "#" + (i + 1);
    a.textContent = slide.getAttribute("aria-label") || "Slide " + (i + 1);
    li.appendChild(a);
    list.appendChild(li);
  });

  function openOverlay() {
    lastFocus = document.activeElement;
    overlay.hidden = false;
    var active = list.querySelector('[aria-current="true"]') || list.querySelector("a");
    if (active) active.focus();
  }

  function closeOverlay() {
    overlay.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  list.addEventListener("click", function () {
    // The link's own hash change moves the deck; just close.
    window.setTimeout(closeOverlay, 0);
  });
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeOverlay();
  });

  // ---- Lightbox ---------------------------------------------------------------------------
  function openLightbox(img) {
    lastFocus = document.activeElement;
    lightboxImg.src = img.currentSrc || img.src;
    lightboxImg.alt = img.alt;
    lightbox.hidden = false;
    lightbox.tabIndex = -1;
    lightbox.focus();
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.removeAttribute("src");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  deck.addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest(".shot__zoom") : null;
    if (button) openLightbox(button.querySelector("img"));
  });
  lightbox.addEventListener("click", closeLightbox);

  // ---- Theme ------------------------------------------------------------------------------
  function storedTheme() {
    try {
      return window.localStorage.getItem(THEME_KEY);
    } catch (_) {
      return null;
    }
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function toggleTheme() {
    var explicit = document.documentElement.getAttribute("data-theme");
    var dark = explicit
      ? explicit === "dark"
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = dark ? "light" : "dark";
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch (_) {
      /* storage unavailable (private mode or file:// policy): the toggle still works */
    }
  }

  applyTheme(storedTheme());

  // ---- Notes ------------------------------------------------------------------------------
  function toggleNotes() {
    var on = document.body.classList.toggle("show-notes");
    if (notesButton) notesButton.setAttribute("aria-pressed", on ? "true" : "false");
  }

  // ---- Controls ---------------------------------------------------------------------------
  document.querySelector(".controls").addEventListener("click", function (e) {
    var button = e.target.closest ? e.target.closest("[data-action]") : null;
    if (!button) return;
    var action = button.getAttribute("data-action");
    if (action === "prev") go(-1);
    else if (action === "next") go(1);
    else if (action === "index") openOverlay();
    else if (action === "notes") toggleNotes();
    else if (action === "theme") toggleTheme();
  });

  progress.addEventListener("click", function (e) {
    var rect = progress.getBoundingClientRect();
    var ratio = (e.clientX - rect.left) / rect.width;
    show(Math.round(ratio * (slides.length - 1)));
  });

  document.addEventListener("keydown", function (e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!lightbox.hidden) {
      if (e.key === "Escape") closeLightbox();
      return;
    }
    if (!overlay.hidden) {
      if (e.key === "Escape" || e.key === "g" || e.key === "o") {
        e.preventDefault();
        closeOverlay();
      }
      return;
    }
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
      case "PageDown":
        e.preventDefault();
        go(1);
        break;
      case " ":
        if (e.target.closest && e.target.closest("button, a")) return;
        e.preventDefault();
        go(e.shiftKey ? -1 : 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
      case "PageUp":
        e.preventDefault();
        go(-1);
        break;
      case "Home":
        e.preventDefault();
        show(0);
        break;
      case "End":
        e.preventDefault();
        show(slides.length - 1);
        break;
      case "g":
      case "o":
        e.preventDefault();
        openOverlay();
        break;
      case "n":
        toggleNotes();
        break;
      case "t":
        toggleTheme();
        break;
      default:
        break;
    }
  });

  // ---- Touch swipe ------------------------------------------------------------------------
  var startX = null;
  var startY = null;
  deck.addEventListener(
    "touchstart",
    function (e) {
      startX = e.changedTouches[0].clientX;
      startY = e.changedTouches[0].clientY;
    },
    { passive: true },
  );
  deck.addEventListener(
    "touchend",
    function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;
      startX = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    },
    { passive: true },
  );

  window.addEventListener("hashchange", function () {
    // The skip link targets #deck, which is not a slide number: leave the current slide alone.
    if (isNaN(parseInt(window.location.hash.replace(/^#\/?/, ""), 10))) return;
    show(readHash(), false);
  });

  show(readHash(), false);
})();
