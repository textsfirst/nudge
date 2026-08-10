import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { Button } from "@/components/ui/button";

/** One-shot destructive confirmation, wrapping any trigger element. */
export function Confirm({
  title,
  description,
  actionLabel,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  return (
    <AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Trigger asChild>{children}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <AlertDialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 shadow-lg outline-none">
          <AlertDialogPrimitive.Title className="text-base font-semibold">
            {title}
          </AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
            {description}
          </AlertDialogPrimitive.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="outline">Cancel</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant="destructive" onClick={onConfirm}>
                {actionLabel}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
