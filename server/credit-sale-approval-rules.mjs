function normalizedText(value) {
  return String(value ?? "").trim();
}

function isActivePersonnel(person = {}) {
  return person?.employmentStatus !== "resigned" && !person?.resignedAt;
}

export function creditSaleOrderOwner(personnel = [], order = {}) {
  const reference = normalizedText(order?.contactPerson);
  if (!reference) return null;
  return (Array.isArray(personnel) ? personnel : []).find((person) =>
    isActivePersonnel(person) &&
    normalizedText(person?.username) &&
    (normalizedText(person?.name) === reference || normalizedText(person?.username) === reference)
  ) ?? null;
}

export function creditSaleEligibleApprovers(personnel = [], order = {}) {
  const people = Array.isArray(personnel) ? personnel : [];
  const owner = creditSaleOrderOwner(people, order);
  const recipients = new Map();

  for (const person of people) {
    const username = normalizedText(person?.username);
    if (!username || !isActivePersonnel(person) || person?.accessRole !== "admin") continue;
    recipients.set(username, {
      username,
      name: normalizedText(person?.name) || username,
      isAdmin: true,
      isOrderOwner: owner?.username === username,
    });
  }

  const ownerUsername = normalizedText(owner?.username);
  if (ownerUsername) {
    const existing = recipients.get(ownerUsername);
    recipients.set(ownerUsername, {
      username: ownerUsername,
      name: normalizedText(owner?.name) || ownerUsername,
      isAdmin: existing?.isAdmin === true,
      isOrderOwner: true,
    });
  }

  return [...recipients.values()];
}

export function canApproveCreditSale(personnel = [], order = {}, username = "") {
  const operator = normalizedText(username);
  if (!operator) return false;
  return creditSaleEligibleApprovers(personnel, order)
    .some((recipient) => recipient.username === operator);
}

export function isCreditSaleOrderOwner(personnel = [], order = {}, username = "") {
  const operator = normalizedText(username);
  return Boolean(operator && normalizedText(creditSaleOrderOwner(personnel, order)?.username) === operator);
}
