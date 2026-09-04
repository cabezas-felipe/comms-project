import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { isUxTestMode } from "@/lib/ux-test-mode";

export function notifyWarning(message: string) {
  if (isUxTestMode) return;
  toast.warning(message, {
    icon: <AlertTriangle className="h-4 w-4" style={{ color: "hsl(var(--signal-warning))" }} />,
  });
}

export function notifyError(message: string) {
  if (isUxTestMode) return;
  toast.error(message, {
    icon: <AlertCircle className="h-4 w-4" style={{ color: "hsl(var(--destructive))" }} />,
  });
}

export function notifySuccess(message: string) {
  if (isUxTestMode) return;
  toast.success(message, {
    icon: <CheckCircle2 className="h-4 w-4" style={{ color: "hsl(var(--signal-positive))" }} />,
  });
}
