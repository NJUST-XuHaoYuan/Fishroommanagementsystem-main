function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function title(parts) {
  return parts.filter(Boolean).join(" · ");
}

function specimenContactCard(specimen, quantity = 1) {
  if (!specimen || !clean(specimen.id)) return null;
  const grouped = Number.isSafeInteger(quantity) && quantity > 1;
  return {
    title: title([
      clean(specimen.productName) || "商品咨询",
      grouped ? `同款可选 ${quantity} ${clean(specimen.unit) || "条"}` : clean(specimen.code) ? `编号 ${clean(specimen.code)}` : "",
      clean(specimen.size), clean(specimen.origin)
    ]),
    // Internal IDs stay in the link. Customers never have to copy or enter them.
    path: `/pages/detail/index?stockItemId=${encodeURIComponent(specimen.id)}${grouped ? "&group=1" : ""}`
  };
}

module.exports = { specimenContactCard };
