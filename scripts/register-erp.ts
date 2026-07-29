/**
 * One-off: register the JWM ERP as a target site and link the operator's
 * account on it. Idempotent — safe to re-run.
 */
import postgres from "postgres";
import { encryptSecret } from "./src/secrets";

const BP_DB = "postgresql://browserpilot:DYcLaoOkO0OxNwXEp7li8xXVN0GbeWpr@46.4.244.39:5433/browserpilot";
const ERP_DB = "postgresql://jwm:VNueRkL9VvKH2bT717iikaoQ@46.4.244.39:5498/jwm_prod";
const MASTER_KEY = "jOdWZ0HLa3gG7e1RAmj22IwFAmI3CCNcbfhZPL369LXU";
const ERP_SECRET = "b90cbc25c3f095fada58027e997af09a";
const OPERATOR_EMAIL = "manansantoki2003@gmail.com";

const NOTES = `This is a wire-mesh manufacturing ERP. Vocabulary you will meet:
- PO = purchase order (wire bought from suppliers). Wire is described by type (SS), grade (304L, 316L), diameter in mm, and quantity in kg.
- Enquiry = a customer asking for a quote. Orders come from accepted enquiries.
- Program = a production run on a machine. Warping prepares the warp beam for it.
- Roll = a produced roll of mesh. FG = finished goods inventory.
- Dispatch = sending finished goods to a customer, with a dispatch PDF.
- Scrap = wire or mesh written off.

Main routes: /dashboard, /purchase-orders, /inventory, /programs, /warping,
/fg-inventory, /enquiries, /orders, /dispatch, /customers, /suppliers,
/machines, /reports, /costing, /scrap, /settings.

Numbers are Indian-format (lakhs/crores) and currency is INR. Dates are
day-first. When a form offers an auto-generate button for a document number,
prefer it over inventing one.`;

const DESTRUCTIVE = ["delete", "remove", "cancel", "void", "discard", "scrap", "revoke", "reset"];

const bp = postgres(BP_DB, { max: 1 });
const erp = postgres(ERP_DB, { max: 1 });

const [erpUser] = await erp`
  select id, name, email, role from users where email = ${OPERATOR_EMAIL} limit 1`;
if (!erpUser) {
  console.error(`No ERP account for ${OPERATOR_EMAIL}`);
  process.exit(1);
}

const [bpUser] = await bp`
  select id from users where email = ${OPERATOR_EMAIL} limit 1`;
if (!bpUser) {
  console.error(`No BrowserPilot account for ${OPERATOR_EMAIL}`);
  process.exit(1);
}

const sealed = encryptSecret(ERP_SECRET, MASTER_KEY);

const [site] = await bp`
  insert into site_profiles
    (name, base_url, login_strategy, cookie_name, secret_encrypted, system_prompt_notes,
     destructive_patterns, is_active, created_by_id)
  values
    ('JWM ERP', 'https://erp.jalaramwiremesh.com', 'cookie_mint', 'jwm-session',
     ${sealed}, ${NOTES}, ${JSON.stringify(DESTRUCTIVE)}::jsonb, true, ${bpUser.id})
  on conflict (name) do update set
    base_url = excluded.base_url,
    cookie_name = excluded.cookie_name,
    secret_encrypted = excluded.secret_encrypted,
    system_prompt_notes = excluded.system_prompt_notes,
    destructive_patterns = excluded.destructive_patterns,
    is_active = true,
    updated_at = now()
  returning id, name, base_url`;

await bp`
  insert into site_accounts
    (site_profile_id, user_id, target_user_id, target_email, target_name, target_role)
  values
    (${site.id}, ${bpUser.id}, ${erpUser.id}, ${erpUser.email}, ${erpUser.name}, ${erpUser.role})
  on conflict (site_profile_id, user_id) do update set
    target_user_id = excluded.target_user_id,
    target_email = excluded.target_email,
    target_name = excluded.target_name,
    target_role = excluded.target_role`;

console.log(`Registered "${site.name}" → ${site.base_url}`);
console.log(`Operator acts as ${erpUser.name} <${erpUser.email}> (${erpUser.role}) on the ERP.`);

await bp.end();
await erp.end();
