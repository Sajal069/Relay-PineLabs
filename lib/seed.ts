import { sampleForm, type FormInput } from "./model";

export const fixtures = [
  { name: "Saffron & Sage", initials: "SS", city: "Mumbai", sector: "Food & beverage", age: 42, state: "review", case: "gst" },
  { name: "Indigo Loom", initials: "IL", city: "Jaipur", sector: "Apparel & textiles", age: 26, state: "verifying", case: "bank" },
  { name: "Nila Organics", initials: "NO", city: "Bengaluru", sector: "Beauty & wellness", age: 68, state: "review", case: "pan" },
  { name: "Copper Kite Studio", initials: "CK", city: "Pune", sector: "Design services", age: 95, state: "approved", case: "active" },
  { name: "Terrain Supply Co.", initials: "TS", city: "Delhi", sector: "Outdoor retail", age: 124, state: "correction", case: "bank" },
  { name: "Mango Grove Foods", initials: "MG", city: "Hyderabad", sector: "Food & beverage", age: 160, state: "verifying", case: "gst" },
  { name: "Aster Home Goods", initials: "AH", city: "Ahmedabad", sector: "Home & living", age: 188, state: "approved", case: "active" },
  { name: "Kora Learning", initials: "KL", city: "Chennai", sector: "Education", age: 243, state: "review", case: "timeout" },
  { name: "Blue Banyan Travel", initials: "BB", city: "Kochi", sector: "Travel & tourism", age: 310, state: "verifying", case: "pan" },
  { name: "Juniper Cycle Works", initials: "JC", city: "Chandigarh", sector: "Sports & recreation", age: 405, state: "approved", case: "active" },
] as const;

export function fixtureForm(fixture: (typeof fixtures)[number], index: number): FormInput {
  const suffix = String(2910 + index);
  const pan = index === 0 ? "ZZZCS2944Z" : `ZZZCS${suffix}Z`;
  const account = `90000067${suffix}`;
  const legalName = index === 0 ? "Saffron & Sage Hospitality LLP" : `${fixture.name} Private Limited`;
  return {
    ...sampleForm,
    name: fixture.name,
    city: fixture.city,
    sector: fixture.sector,
    legalName,
    gstin: index === 0 ? "27ZZZCS2944Z9Z8" : `27${pan}9Z9`,
    pan,
    account,
    signatory: "Meera Das",
    documents: {
      pan: { value: pan, quality: fixture.name === "Nila Organics" ? "blurred" : "clear" },
      gst: { value: index === 0 ? "Saffron & Sage Hospitality Private Limited" : legalName, quality: "clear" },
      bank: { value: fixture.state === "correction" ? "900000678192" : account, quality: "clear" },
    },
  };
}
