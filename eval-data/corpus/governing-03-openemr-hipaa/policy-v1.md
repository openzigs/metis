# Electronic Health Record Security Requirements: HIPAA Security Rule and NIST SP 800-63B

Revision: v1 · Compiled: 2026-11-09 · Applies to: the electronic health record system, its patient portal and its interfaces

## Sources and attribution

Every obligation below is quoted from one of two public sources. The reference in bold at the
start of each paragraph is added here so that a question can name the obligation, and the
source's own citation follows each one in square brackets. Text left out of a quotation is
marked "…", and a footnote marker is dropped. Nothing else in a quotation has been changed.

- **Part A** quotes 45 CFR 164.312, Technical safeguards, and 45 CFR 164.308(a)(5)(ii)(C)
  and (D), from the Electronic Code of Federal Regulations:
  https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312
  and https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.308,
  retrieved 2026-11-09. United States federal regulation, in the public domain.
- **Part B** quotes NIST Special Publication 800-63B-4, Digital Identity Guidelines:
  Authentication and Authenticator Management: https://pages.nist.gov/800-63-4/sp800-63b.html,
  retrieved 2026-11-09. A work of the United States federal government, not subject to
  copyright in the United States.

## How Part B reads here

Part B is written for federal agencies. Here the verifier and the credential service provider
(CSP) are the system that signs its users in, the relying party (RP) is the application they
use once signed in, and the subscriber or claimant is the user: a member of staff, or a
patient using the portal. Where Part B sets a requirement for each authentication assurance
level, the AAL2 requirement is the one quoted.

## Part A — HIPAA Security Rule

A covered entity or business associate must, in accordance with § 164.306:

**TS-01** Standard: Access control. Implement technical policies and procedures for electronic information systems that maintain electronic protected health information to allow access only to those persons or software programs that have been granted access rights as specified in § 164.308(a)(4). [45 CFR 164.312(a)(1)]

**TS-02** Unique user identification (Required). Assign a unique name and/or number for identifying and tracking user identity. [45 CFR 164.312(a)(2)(i)]

**TS-03** Emergency access procedure (Required). Establish (and implement as needed) procedures for obtaining necessary electronic protected health information during an emergency. [45 CFR 164.312(a)(2)(ii)]

**TS-04** Automatic logoff (Addressable). Implement electronic procedures that terminate an electronic session after a predetermined time of inactivity. [45 CFR 164.312(a)(2)(iii)]

**TS-05** Encryption and decryption (Addressable). Implement a mechanism to encrypt and decrypt electronic protected health information. [45 CFR 164.312(a)(2)(iv)]

**TS-06** Standard: Audit controls. Implement hardware, software, and/or procedural mechanisms that record and examine activity in information systems that contain or use electronic protected health information. [45 CFR 164.312(b)]

**TS-07** Standard: Integrity. Implement policies and procedures to protect electronic protected health information from improper alteration or destruction. [45 CFR 164.312(c)(1)]

**TS-08** Mechanism to authenticate electronic protected health information (Addressable). Implement electronic mechanisms to corroborate that electronic protected health information has not been altered or destroyed in an unauthorized manner. [45 CFR 164.312(c)(2)]

**TS-09** Standard: Person or entity authentication. Implement procedures to verify that a person or entity seeking access to electronic protected health information is the one claimed. [45 CFR 164.312(d)]

**TS-10** Standard: Transmission security. Implement technical security measures to guard against unauthorized access to electronic protected health information that is being transmitted over an electronic communications network. [45 CFR 164.312(e)(1)]

**TS-11** Integrity controls (Addressable). Implement security measures to ensure that electronically transmitted electronic protected health information is not improperly modified without detection until disposed of. [45 CFR 164.312(e)(2)(i)]

**TS-12** Encryption (Addressable). Implement a mechanism to encrypt electronic protected health information whenever deemed appropriate. [45 CFR 164.312(e)(2)(ii)]

As part of its security awareness and training program, a covered entity or business associate must implement:

**AS-01** Log-in monitoring (Addressable). Procedures for monitoring log-in attempts and reporting discrepancies. [45 CFR 164.308(a)(5)(ii)(C)]

**AS-02** Password management (Addressable). Procedures for creating, changing, and safeguarding passwords. [45 CFR 164.308(a)(5)(ii)(D)]

## Part B — NIST SP 800-63B-4

### Passwords

**PW-01** Passwords SHALL either be chosen by the subscriber or assigned randomly by the CSP. [SP 800-63B-4, Password Authenticators]

**PW-02** Verifiers and CSPs SHALL require passwords that are used as a single-factor authentication mechanism to be a minimum of 15 characters in length. Verifiers and CSPs MAY allow passwords that are only used as part of multi-factor authentication processes to be shorter but SHALL require them to be a minimum of eight characters in length. [SP 800-63B-4, Password Verifiers]

**PW-03** Verifiers and CSPs SHALL NOT impose other composition rules (e.g., requiring mixtures of different character types) for passwords. [SP 800-63B-4, Password Verifiers]

**PW-04** Verifiers and CSPs SHALL NOT require subscribers to change passwords periodically. However, verifiers SHALL force a change if there is evidence that the authenticator has been compromised. [SP 800-63B-4, Password Verifiers]

**PW-05** Verifiers and CSPs SHALL NOT permit the subscriber to store a hint (e.g., a reminder of how the password was created) that is accessible to an unauthenticated claimant. [SP 800-63B-4, Password Verifiers]

**PW-06** Verifiers and CSPs SHALL NOT prompt subscribers to use knowledge-based authentication (KBA) (e.g., “What was the name of your first pet?”) or security questions when choosing passwords. [SP 800-63B-4, Password Verifiers]

**PW-07** When processing a request to establish or change a password, verifiers SHALL compare the prospective secret against a blocklist that contains known commonly used, expected, or compromised passwords. [SP 800-63B-4, Password Verifiers]

**PW-08** Verifiers SHALL allow the use of password managers and autofill functionality. Verifiers SHOULD permit claimants to use the “paste” function when entering a password to facilitate password manager use when password autofill APIs are unavailable. [SP 800-63B-4, Password Verifiers]

**PW-09** Verifiers and CSPs SHALL use approved encryption and an authenticated protected channel when requesting passwords. [SP 800-63B-4, Password Verifiers]

**PW-10** Verifiers SHALL store passwords in a form that is resistant to offline attacks. Passwords SHALL be salted and hashed using a suitable password hashing scheme. [SP 800-63B-4, Password Verifiers]

### Authenticators

**AU-01** At AAL2, authentication SHALL use either a multi-factor authenticator or a combination of two separate authentication factors. [SP 800-63B-4, Authentication Assurance Level 2, Permitted Authenticator Types]

**AU-02** Unless otherwise specified in the description of a given authenticator, the verifier SHALL limit consecutive failed authentication attempts using a specific authenticator on a single subscriber account to no more than 100 by disabling that authenticator. … Authenticators that have been disabled SHALL be required to rebind to the subscriber account … to be usable in the future. [SP 800-63B-4, Rate Limiting (Throttling)]

**AU-03** When an authenticator is added, the CSP SHALL notify the subscriber via a mechanism independent of the transaction binding the new authenticator … [SP 800-63B-4, Binding an Additional Authenticator]

**AU-04** The CSP SHALL provide a mechanism to invalidate the authenticator immediately upon notification from a subscriber that the authenticator’s loss, theft, or compromise is suspected. [SP 800-63B-4, Physical Authenticators]

### Sessions

**SM-01** A definite reauthentication overall timeout SHALL be established, which SHOULD be no more than 24 hours at AAL2. The inactivity timeout SHOULD be no more than 1 hour. [SP 800-63B-4, Authentication Assurance Level 2, Reauthentication]

**SM-02** When either timeout expires, the session SHALL be terminated. Session activity SHALL reset the inactivity timeout, and successful reauthentication during a session SHALL reset both timeouts. [SP 800-63B-4, Reauthentication]

**SM-03** Following authentication, authenticated sessions SHALL NOT fall back to an insecure transport (e.g., from https to http). [SP 800-63B-4, Session Bindings]

**SM-04** POST/PUT content SHALL contain a session identifier that the RP SHALL verify to protect against cross-site request forgery (CSRF). [SP 800-63B-4, Session Bindings]
