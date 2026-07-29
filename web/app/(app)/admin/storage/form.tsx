"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveStorageSettings, type AdminState } from "../actions";

const initial: AdminState = {};

const DRIVERS = [
  { value: "s3", label: "An S3 bucket" },
  { value: "local", label: "This server's disk" },
];

type Current = {
  driver: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  hasSecret: boolean;
};

export function StorageForm({ current }: { current: Current }) {
  const [state, action, pending] = useActionState(saveStorageSettings, initial);
  const [driver, setDriver] = useState(current.driver);

  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where downloads go</CardTitle>
          <CardDescription>
            Files on this server&apos;s disk are lost when it is redeployed. A bucket keeps them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            name="storageDriver"
            value={driver}
            onValueChange={(v) => setDriver(v ?? "s3")}
            items={DRIVERS}
          >
            <SelectTrigger className="w-full" aria-label="Storage">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DRIVERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {driver === "s3" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bucket</CardTitle>
            <CardDescription>
              Leave the endpoint empty for Amazon S3. Any other provider — MinIO, Cloudflare R2,
              Backblaze — needs its own.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="s3Bucket">Bucket name</Label>
              <Input id="s3Bucket" name="s3Bucket" defaultValue={current.bucket} required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="s3Endpoint">
                Endpoint <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="s3Endpoint"
                name="s3Endpoint"
                defaultValue={current.endpoint}
                placeholder="http://browserpilot-minio:9000"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="s3Region">
                Region <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Input
                id="s3Region"
                name="s3Region"
                defaultValue={current.region}
                placeholder="us-east-1"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="s3AccessKeyId">Access key ID</Label>
              <Input
                id="s3AccessKeyId"
                name="s3AccessKeyId"
                defaultValue={current.accessKeyId}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="s3SecretAccessKey">Secret access key</Label>
              <Input
                id="s3SecretAccessKey"
                name="s3SecretAccessKey"
                type="password"
                placeholder={current.hasSecret ? "•••••••• (leave empty to keep)" : ""}
              />
              <p className="text-muted-foreground text-xs">
                Encrypted before it is stored, and never shown again.
              </p>
            </div>

            <label className="flex items-center gap-3 text-sm">
              <Switch name="s3ForcePathStyle" defaultChecked={current.forcePathStyle} />
              <span>
                Address the bucket by path
                <span className="text-muted-foreground block text-xs">
                  Needed by MinIO and most self-hosted gateways. Amazon S3 does not use it.
                </span>
              </span>
            </label>
          </CardContent>
        </Card>
      ) : null}

      {state.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      {state.success ? <p className="text-running text-sm">{state.success}</p> : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save storage"}
      </Button>
    </form>
  );
}
