import { useState } from "react";
import { Column, DropdownWrapper, Input, Option, Text } from "@once-ui-system/core";

type AppSelectProps = {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onSelect: (value: string) => void;
};
const emptyOptionValue = "__arrbiter_empty_option__";

// Once UI's Select opens on input focus. Its dropdown restores that focus when
// it closes, which opens the menu again. Keep the Once UI menu primitives, but
// open this read-only trigger only for an explicit click or key press.
export function AppSelect({ id, label, value, options, onSelect }: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return <DropdownWrapper
    fillWidth
    open={open}
    onOpenChange={setOpen}
    onSelect={(next) => { onSelect(next === emptyOptionValue ? "" : next); setOpen(false); }}
    trigger={<Input
      id={id}
      label={label}
      value={selected?.label || ""}
      readOnly
      cursor="interactive"
      aria-haspopup="listbox"
      aria-expanded={open}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    />}
    dropdown={<Column fillWidth padding="4" gap="2">
      {options.length ? options.map((option) => <Option
        key={option.value}
        value={option.value || emptyOptionValue}
        label={option.label}
        selected={option.value === value}
        tabIndex={-1}
      />) : <Text variant="body-default-s" onBackground="neutral-weak" padding="12">No options available</Text>}
    </Column>}
  />;
}
