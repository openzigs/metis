/**
 * Epic #196 / #220 — Settings sub-page: Profile tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import SettingsProfilePage from "@/app/(authed)/settings/profile/page";

describe("<SettingsProfilePage />", () => {
  it("renders the profile fields populated from the auth user", () => {
    const Wrapper = makeWrapper({ withAuth: true, initialUser: TEST_USER });
    render(
      <Wrapper>
        <SettingsProfilePage />
      </Wrapper>,
    );
    expect(screen.getByTestId("settings-profile-root")).toBeInTheDocument();
    expect(screen.getByTestId("settings-profile-username")).toHaveTextContent("tester");
    expect(screen.getByTestId("settings-profile-display-name")).toHaveTextContent("Test User");
    expect(screen.getByTestId("settings-profile-email")).toHaveTextContent("test@example.com");
    expect(screen.getByTestId("settings-profile-role")).toHaveTextContent("admin");
  });

  it("falls back to em-dash placeholders when no user is loaded", () => {
    const Wrapper = makeWrapper({ withAuth: true, initialUser: null });
    render(
      <Wrapper>
        <SettingsProfilePage />
      </Wrapper>,
    );
    // Username, email, and role all show the em-dash sentinel.
    expect(screen.getByTestId("settings-profile-username")).toHaveTextContent("—");
    expect(screen.getByTestId("settings-profile-email")).toHaveTextContent("—");
    expect(screen.getByTestId("settings-profile-role")).toHaveTextContent("—");
  });
});
