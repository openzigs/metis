# Harbor Lane Outfitters — Information Handling Policy

Revision: v2 · Effective: 2026-07-01 · Owner: Head of Information Security

This policy sets out the obligations every team at Harbor Lane Outfitters follows when it
handles information. Each numbered obligation below is one rule; its identifier is the
text in bold at the start of the paragraph.

## 1. Access control

**AC-01** Each person who signs in to a company system has an individual named account, and an account is never shared between people.

**AC-02** Staff accounts with administrative power require a second sign-in factor in addition to the password.

**AC-03** A person is granted only the permissions their job role needs, and broader permissions require written approval from the system owner.

**AC-04** Access held by a departing employee or contractor is removed no later than the end of their final working day.

**AC-05** System owners review the list of people with access to their system every month and remove anyone who no longer needs it.

**AC-06** Customer-facing sign-in locks the account for fifteen minutes after five consecutive failed password attempts.

**AC-07** Sessions in internal tools end automatically after thirty minutes without activity.

## 2. Audit logging

**AL-01** Any change to a person's permissions is recorded in the audit trail with who made the change, whose permissions changed and when.

**AL-02** Every bulk extraction of customer or financial records is recorded in the audit trail, naming the person, the time and the scope of what was taken.

**AL-03** Audit trail entries are protected so that no one, including administrators, can alter or delete them.

**AL-04** Security staff examine audit trail alerts for unusual activity at least once a week.

**AL-05** Audit trail entries are kept for at least one year.

**AL-06** Changes to prices, discounts or payment amounts made by staff are recorded in the audit trail with the previous value and the new value.

## 3. Data retention

**DR-01** Financial transaction records are kept for seven years from the end of the fiscal year they belong to.

**DR-02** Personal information about a customer whose account has been closed is erased or anonymised within ninety days of closure, except where another rule requires it to be kept.

**DR-03** Copies of personal information placed in test or training environments are erased within thirty days.

**DR-04** Recorded support calls and chat transcripts are kept no longer than six months.

**DR-05** Every dataset holding personal information has a named owner and a documented retention period.

**DR-06** Records subject to a legal hold are not destroyed until the hold is lifted, whatever their normal retention period.

## 4. Encryption

**EN-01** Personal and payment information is encrypted whenever it travels across a network.

**EN-02** Personal and payment information is encrypted wherever it is stored, including backups.

**EN-03** Full card numbers are never stored; at most the last four digits are kept for display.

**EN-04** Encryption keys are rotated at least once a year and are kept apart from the information they protect.

**EN-05** Files containing personal information that are sent to an outside party are protected so that only the intended recipient can open them.

## 5. Change management

**CM-01** Every change to a production system is approved by someone other than the person who made it before it goes live.

**CM-02** Changes are tested in an environment separate from production before release.

**CM-03** Each production change has a documented way to undo it.

**CM-04** Emergency changes made without prior approval are reviewed and approved within two working days afterwards.

**CM-05** Customers are told at least five working days in advance of planned downtime of a customer-facing service.

**CM-06** Developers do not have standing permission to change production data directly.

## 6. Vendor management

**VM-01** Before an outside company receives personal or payment information, it completes a security review and signs a data protection agreement.

**VM-02** Outside companies that handle personal information are re-assessed every year.

**VM-03** Each outside company is given only the information needed for the service it provides.

**VM-04** Contracts with outside companies require them to report a security incident affecting our information within forty-eight hours.

**VM-05** A register of every outside company that handles personal information is kept current, including what information each one receives.

## 7. Privacy

**PR-01** Personal information is collected only for a purpose stated to the customer at the point of collection.

**PR-02** Marketing messages are sent only to customers who have opted in, and every message offers a one-step way to opt out.

**PR-03** A customer's request to see the personal information held about them is answered within thirty days.

**PR-04** Precise location is collected only after the customer gives explicit permission, and that permission can be withdrawn at any time.

**PR-05** Personal information of children under sixteen is not collected without the verified consent of a parent or guardian.
