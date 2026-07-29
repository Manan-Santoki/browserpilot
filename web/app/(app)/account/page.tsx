import { requireUser } from "@/lib/auth";
import { setLanguage } from "./actions";
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

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी" },
  { value: "gu", label: "ગુજરાતી" },
];

export default async function AccountPage() {
  const user = await requireUser();

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
