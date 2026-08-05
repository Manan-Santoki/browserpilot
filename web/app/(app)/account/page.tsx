import { requireUser } from "@/lib/auth";
import { setLanguage, setPreferredModel } from "./actions";
import { PasswordForm } from "./password-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { modelsIncluding } from "@/lib/models";

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी" },
  { value: "gu", label: "ગુજરાતી" },
];

export default async function AccountPage() {
  const user = await requireUser();
  const models = await modelsIncluding(user.preferredModel ?? "");

  return (
    <div className="mx-auto w-full max-w-6xl max-w-lg space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {user.name} · {user.email} · {user.role === "ADMIN" ? "administrator" : "user"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
        </CardHeader>
        <CardContent>
          <PasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preferred model</CardTitle>
          <CardDescription>
            Used for every new session unless you pick a different one at start.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={setPreferredModel} className="flex items-center gap-2">
            <Select
              name="model"
              defaultValue={user.preferredModel ?? ""}
              items={[
                { value: "", label: "Use the default (site's choice)" },
                ...models.map((m) => ({ value: m.value, label: m.label })),
              ]}
            >
              <SelectTrigger className="w-[240px]" aria-label="Preferred model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">Use the default</SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Speech language</CardTitle>
          <CardDescription>
            The default for push-to-talk. You can still switch it per recording.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={setLanguage} className="flex items-center gap-2">
            <Select
              name="language"
              defaultValue={user.preferredLanguage}
              items={LANGUAGES}
            >
              <SelectTrigger className="w-[160px]" aria-label="Speech language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
