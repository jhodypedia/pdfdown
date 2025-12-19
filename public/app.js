function showLoading(on) {
  $("#loading").toggleClass("hidden", !on).toggleClass("flex", on);
}

function toast(msg, ok = true) {
  $("#toast")
    .removeClass("hidden bg-emerald-500/10 text-emerald-200 bg-rose-500/10 text-rose-200")
    .addClass(ok ? "bg-emerald-500/10 text-emerald-200" : "bg-rose-500/10 text-rose-200")
    .text(msg);
  clearTimeout(window.__t);
  window.__t = setTimeout(() => $("#toast").addClass("hidden"), 3500);
}

function buildApi(base) {
  const url = $("#url").val().trim();
  const filename = $("#filename").val().trim();
  if (!url) return null;

  const qs = new URLSearchParams({ url });
  if (filename) qs.set("filename", filename);
  return `${base}?${qs.toString()}`;
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return "-";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = Number(bytes);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

$("#btnCheck").on("click", function () {
  const url = $("#url").val().trim();
  if (!url) return toast("Isi URL dulu.", false);

  showLoading(true);
  $("#meta").addClass("hidden");
  $.ajax({
    url: "/api/meta",
    method: "GET",
    data: { url },
    dataType: "json",
    timeout: 25000
  })
    .done((r) => {
      if (!r?.ok) return toast("Gagal ambil metadata.", false);

      $("#mName").text(r.filename || "-");
      $("#mType").text(r.contentType || "-");
      $("#mSize").text(humanSize(r.contentLength));
      $("#meta").removeClass("hidden");

      // Auto set filename input jika kosong
      if (!$("#filename").val().trim() && r.filename) {
        $("#filename").val(r.filename);
      }

      toast("Metadata berhasil diambil.", true);
    })
    .fail((xhr) => {
      const msg = xhr?.responseJSON?.error || xhr?.responseJSON?.detail || "Request gagal.";
      toast(msg, false);
    })
    .always(() => showLoading(false));
});

$("#btnDownload").on("click", function () {
  const api = buildApi("/api/pdf");
  if (!api) return toast("Isi URL dulu.", false);
  toast("Mulai download…", true);
  window.location.href = api; // download pakai header attachment
});

$("#btnOpen").on("click", function () {
  const api = buildApi("/api/pdf");
  if (!api) return toast("Isi URL dulu.", false);
  window.open(api, "_blank");
});

$("#btnPreview").on("click", function () {
  const api = buildApi("/api/pdf");
  if (!api) return toast("Isi URL dulu.", false);

  // Preview via iframe (bisa gagal kalau upstream ngirim attachment; tapi masih bisa render di banyak browser)
  $("#previewFrame").attr("src", api);
  $("#previewWrap").removeClass("hidden");
  toast("Preview dibuka.", true);
});
