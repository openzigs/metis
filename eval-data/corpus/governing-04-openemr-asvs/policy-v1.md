# Web Application Security Requirements: OWASP ASVS 5.0.0 (excerpts)

Revision: v1 · Compiled: 2026-11-09 · Applies to: the electronic health record system, its patient portal and its interfaces

## Sources and attribution

Every requirement below is quoted from the OWASP Application Security Verification Standard
5.0.0, by the OWASP Foundation: https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0/en,
retrieved 2026-11-09. The ASVS is released under the Creative Commons Attribution-ShareAlike
4.0 International License (https://creativecommons.org/licenses/by-sa/4.0/), and this file,
which quotes it, stays under that licence whatever the licence of the repository around it.

The reference in bold at the start of each paragraph is added here so that a question can
name the requirement, and the ASVS's own requirement number follows each one in square
brackets. Text left out of a quotation is marked "…": in PA-10, SE-03 and LG-03 a sentence
that sets a stricter level, or covers self-contained tokens, is cut. Nothing else in a
quotation has been changed.

## Part A — Authentication (ASVS chapter V6)

**PA-01** Verify that user set passwords are at least 8 characters in length although a minimum of 15 characters is strongly recommended. [ASVS 5.0.0, 6.2.1]

**PA-02** Verify that users can change their password. [ASVS 5.0.0, 6.2.2]

**PA-03** Verify that password change functionality requires the user's current and new password. [ASVS 5.0.0, 6.2.3]

**PA-04** Verify that passwords submitted during account registration or password change are checked against an available set of, at least, the top 3000 passwords which match the application's password policy, e.g. minimum length. [ASVS 5.0.0, 6.2.4]

**PA-05** Verify that passwords of any composition can be used, without rules limiting the type of characters permitted. There must be no requirement for a minimum number of upper or lower case characters, numbers, or special characters. [ASVS 5.0.0, 6.2.5]

**PA-06** Verify that password input fields use type=password to mask the entry. Applications may allow the user to temporarily view the entire masked password, or the last typed character of the password. [ASVS 5.0.0, 6.2.6]

**PA-07** Verify that "paste" functionality, browser password helpers, and external password managers are permitted. [ASVS 5.0.0, 6.2.7]

**PA-08** Verify that a user's password stays valid until it is discovered to be compromised or the user rotates it. The application must not require periodic credential rotation. [ASVS 5.0.0, 6.2.10]

**PA-09** Verify that controls to prevent attacks such as credential stuffing and password brute force are implemented according to the application's security documentation. [ASVS 5.0.0, 6.3.1]

**PA-10** Verify that either a multi-factor authentication mechanism or a combination of single-factor authentication mechanisms, must be used in order to access the application. … [ASVS 5.0.0, 6.3.3]

**PA-11** Verify that users are notified after updates to authentication details, such as credential resets or modification of the username or email address. [ASVS 5.0.0, 6.3.7]

**PA-12** Verify that system generated initial passwords or activation codes are securely randomly generated, follow the existing password policy, and expire after a short period of time or after they are initially used. These initial secrets must not be permitted to become the long term password. [ASVS 5.0.0, 6.4.1]

**PA-13** Verify that a secure process for resetting a forgotten password is implemented, that does not bypass any enabled multi-factor authentication mechanisms. [ASVS 5.0.0, 6.4.3]

**PA-14** Verify that administrative users can initiate the password reset process for the user, but that this does not allow them to change or choose the user's password. This prevents a situation where they know the user's password. [ASVS 5.0.0, 6.4.6]

**PA-15** Verify that, if an application uses a separate Identity Provider (IdP) and expects specific authentication strength, methods, or recentness for specific functions, the application verifies this using the information returned by the IdP. [ASVS 5.0.0, 6.8.4]

## Part B — Session management (ASVS chapter V7)

**SE-01** Verify that the application generates a new session token on user authentication, including re-authentication, and terminates the current session token. [ASVS 5.0.0, 7.2.4]

**SE-02** Verify that there is an inactivity timeout such that re-authentication is enforced according to risk analysis and documented security decisions. [ASVS 5.0.0, 7.3.1]

**SE-03** Verify that when session termination is triggered (such as logout or expiration), the application disallows any further use of the session. For reference tokens or stateful sessions, this means invalidating the session data at the application backend. … [ASVS 5.0.0, 7.4.1]

**SE-04** Verify that the application gives the option to terminate all other active sessions after a successful change or removal of any authentication factor (including password change via reset or recovery and, if present, an MFA settings update). [ASVS 5.0.0, 7.4.3]

**SE-05** Verify that all pages that require authentication have easy and visible access to logout functionality. [ASVS 5.0.0, 7.4.4]

**SE-06** Verify that session lifetime and termination between Relying Parties (RPs) and Identity Providers (IdPs) behave as documented, requiring re-authentication as necessary such as when the maximum time between IdP authentication events is reached. [ASVS 5.0.0, 7.6.1]

## Part C — Authorization (ASVS chapter V8)

**AZ-01** Verify that the application ensures that function-level access is restricted to consumers with explicit permissions. [ASVS 5.0.0, 8.2.1]

**AZ-02** Verify that the application ensures that data-specific access is restricted to consumers with explicit permissions to specific data items to mitigate insecure direct object reference (IDOR) and broken object level authorization (BOLA). [ASVS 5.0.0, 8.2.2]

**AZ-03** Verify that the application enforces authorization rules at a trusted service layer and doesn't rely on controls that an untrusted consumer could manipulate, such as client-side JavaScript. [ASVS 5.0.0, 8.3.1]

## Part D — Data protection (ASVS chapter V14)

**DP-01** Verify that sensitive data is only sent to the server in the HTTP message body or header fields, and that the URL and query string do not contain sensitive information, such as an API key or session token. [ASVS 5.0.0, 14.2.1]

## Part E — Security logging (ASVS chapter V16)

**LG-01** Verify that each log entry includes necessary metadata (such as when, where, who, what) that would allow for a detailed investigation of the timeline when an event happens. [ASVS 5.0.0, 16.2.1]

**LG-02** Verify that all authentication operations are logged, including successful and unsuccessful attempts. Additional metadata, such as the type of authentication or factors used, should also be collected. [ASVS 5.0.0, 16.3.1]

**LG-03** Verify that failed authorization attempts are logged. … [ASVS 5.0.0, 16.3.2]

**LG-04** Verify that all logging components appropriately encode data to prevent log injection. [ASVS 5.0.0, 16.4.1]

**LG-05** Verify that logs are protected from unauthorized access and cannot be modified. [ASVS 5.0.0, 16.4.2]
