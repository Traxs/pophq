import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RegistrationRolePicker } from "./RegistrationRolePicker";

describe("RegistrationRolePicker", () => {
  it("shows regular and substitute as explicit signup roles", () => {
    const html = renderToStaticMarkup(
      <RegistrationRolePicker substitute={false} disabled={false} busy={false} onChange={() => undefined} />,
    );
    expect(html).toContain("Signup role");
    expect(html).toContain("Regular");
    expect(html).toContain("Substitute");
    expect(html).toContain("Put me on the substitute list");
    expect(html).toContain('aria-checked="true"');
  });

  it("marks substitute as selected when it was saved", () => {
    const html = renderToStaticMarkup(
      <RegistrationRolePicker substitute disabled={false} busy={false} onChange={() => undefined} />,
    );
    expect(html).toMatch(/aria-checked="true" class="registration-role-option is-selected"[^>]*><strong>Substitute/);
  });
});
