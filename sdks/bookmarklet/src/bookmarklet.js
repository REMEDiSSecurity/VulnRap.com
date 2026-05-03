(function () {
  var sel = (window.getSelection && window.getSelection().toString()) || "";
  var text = sel.trim();
  if (!text) {
    var node = document.activeElement;
    if (node && (node.tagName === "TEXTAREA" || node.tagName === "INPUT")) {
      var v = node.value || "";
      var s = node.selectionStart || 0;
      var e = node.selectionEnd || 0;
      text = (s !== e ? v.slice(s, e) : v).trim();
    }
  }
  var MAX = 50000;
  if (text.length > MAX) text = text.slice(0, MAX);
  var base = "https://vulnrap.com/check";
  var url = text ? base + "?text=" + encodeURIComponent(text) : base;
  window.open(url, "_blank", "noopener");
})();
