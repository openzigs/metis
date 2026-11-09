# NIST SP 800-63B-4: Authentication and Authenticator Management (excerpts)

> **Source:** NIST Special Publication 800-63B-4, *Digital Identity Guidelines: Authentication
> and Authenticator Management*, https://pages.nist.gov/800-63-4/sp800-63b.html — retrieved 2026-11-09.
> **Licence:** a work of the United States federal government, not subject to copyright in the
> United States (public domain there).
> Each paragraph below is quoted from the publication; the section it comes from follows in
> square brackets. Text left out is marked "…", and a footnote marker is dropped.
> Here the verifier and the credential service provider (CSP) are the application that signs
> its users in, the relying party (RP) is the application they use once signed in, and the
> subscriber or claimant is the user. Where the publication sets a requirement for each
> authentication assurance level, the AAL2 requirement is the one quoted.
> It is a governing document for the Miniflux walkthrough (#2105); the same text is Part B of
> the `governing-03-openemr-hipaa` eval set's policy.

### Passwords

Passwords SHALL either be chosen by the subscriber or assigned randomly by the CSP. [SP 800-63B-4, Password Authenticators]

Verifiers and CSPs SHALL require passwords that are used as a single-factor authentication mechanism to be a minimum of 15 characters in length. Verifiers and CSPs MAY allow passwords that are only used as part of multi-factor authentication processes to be shorter but SHALL require them to be a minimum of eight characters in length. [SP 800-63B-4, Password Verifiers]

Verifiers and CSPs SHALL NOT impose other composition rules (e.g., requiring mixtures of different character types) for passwords. [SP 800-63B-4, Password Verifiers]

Verifiers and CSPs SHALL NOT require subscribers to change passwords periodically. However, verifiers SHALL force a change if there is evidence that the authenticator has been compromised. [SP 800-63B-4, Password Verifiers]

Verifiers and CSPs SHALL NOT permit the subscriber to store a hint (e.g., a reminder of how the password was created) that is accessible to an unauthenticated claimant. [SP 800-63B-4, Password Verifiers]

Verifiers and CSPs SHALL NOT prompt subscribers to use knowledge-based authentication (KBA) (e.g., “What was the name of your first pet?”) or security questions when choosing passwords. [SP 800-63B-4, Password Verifiers]

When processing a request to establish or change a password, verifiers SHALL compare the prospective secret against a blocklist that contains known commonly used, expected, or compromised passwords. [SP 800-63B-4, Password Verifiers]

Verifiers SHALL allow the use of password managers and autofill functionality. Verifiers SHOULD permit claimants to use the “paste” function when entering a password to facilitate password manager use when password autofill APIs are unavailable. [SP 800-63B-4, Password Verifiers]

Verifiers and CSPs SHALL use approved encryption and an authenticated protected channel when requesting passwords. [SP 800-63B-4, Password Verifiers]

Verifiers SHALL store passwords in a form that is resistant to offline attacks. Passwords SHALL be salted and hashed using a suitable password hashing scheme. [SP 800-63B-4, Password Verifiers]

### Authenticators

At AAL2, authentication SHALL use either a multi-factor authenticator or a combination of two separate authentication factors. [SP 800-63B-4, Authentication Assurance Level 2, Permitted Authenticator Types]

Unless otherwise specified in the description of a given authenticator, the verifier SHALL limit consecutive failed authentication attempts using a specific authenticator on a single subscriber account to no more than 100 by disabling that authenticator. … Authenticators that have been disabled SHALL be required to rebind to the subscriber account … to be usable in the future. [SP 800-63B-4, Rate Limiting (Throttling)]

When an authenticator is added, the CSP SHALL notify the subscriber via a mechanism independent of the transaction binding the new authenticator … [SP 800-63B-4, Binding an Additional Authenticator]

The CSP SHALL provide a mechanism to invalidate the authenticator immediately upon notification from a subscriber that the authenticator’s loss, theft, or compromise is suspected. [SP 800-63B-4, Physical Authenticators]

### Sessions

A definite reauthentication overall timeout SHALL be established, which SHOULD be no more than 24 hours at AAL2. The inactivity timeout SHOULD be no more than 1 hour. [SP 800-63B-4, Authentication Assurance Level 2, Reauthentication]

When either timeout expires, the session SHALL be terminated. Session activity SHALL reset the inactivity timeout, and successful reauthentication during a session SHALL reset both timeouts. [SP 800-63B-4, Reauthentication]

Following authentication, authenticated sessions SHALL NOT fall back to an insecure transport (e.g., from https to http). [SP 800-63B-4, Session Bindings]

POST/PUT content SHALL contain a session identifier that the RP SHALL verify to protect against cross-site request forgery (CSRF). [SP 800-63B-4, Session Bindings]
