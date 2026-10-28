// Loads the guide clip that fits the screen and plays it only while it is on screen.
// Under reduced motion it stays on the poster.
(function () {
  var v = document.querySelector('.guide-video');
  if (!v) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var d = v.dataset, srcs = [d.webm, d.mp4];
  var loaded = false;
  function load() {
    if (loaded) return; loaded = true;
    [['video/webm', srcs[0]], ['video/mp4', srcs[1]]].forEach(function (p) {
      var s = document.createElement('source'); s.type = p[0]; s.src = p[1]; v.appendChild(s);
    });
    v.load();
  }
  if (!('IntersectionObserver' in window)) { load(); v.play().catch(function () {}); return; }
  new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) { load(); v.play().catch(function () {}); } else { v.pause(); }
    });
  }, { threshold: 0.35 }).observe(v);
})();
