# Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

## Purpose of this document

This business requirements document sets out what Northgate Freight needs from a new claims handling application for cargo loss and damage. It is written for the claims operations team, the finance team, the customer service leadership, the legal department and the delivery team that will build or configure the application. It records the business rules that the claims team applies today, the changes the business wants to make to those rules, and the capabilities the new application must provide.

The document was produced over eight weeks by the Operations Business Analysis practice. It draws on interviews with fourteen claims handlers across the three regional claims desks, two workshops with finance and legal, a review of a sample of 400 closed claims from the last two years, and the complaint log kept by customer service. Statements in the background sections describe the current situation and the reasons for change. Requirements are stated in the capability sections. Business rules are stated alongside the capability they govern.

This is version 1.2. Version 1.1 was reviewed by the claims operations steering committee; the changes since then are the addition of the subrogation section, a revised approval matrix and the removal of the customer self-service portal from the first release.

## 1. Executive summary

Northgate Freight moves around 1.8 million consignments a year by road across the national network, through twelve cross-dock depots and around 900 owned and subcontracted vehicles. A small but costly proportion of consignments are lost, damaged or delivered short. Customers claim compensation for those consignments, and Northgate in turn recovers part of the cost from subcontracted hauliers, from its insurers and occasionally from third parties responsible for an accident.

Claims are handled today in a combination of a shared mailbox, a spreadsheet maintained by each regional desk and the finance ledger. Handlers re-key the same data several times, there is no consistent view of a claim's status, and the business has no reliable measure of how long claims take or how much is recovered. In the last year the claims desks handled 6,200 claims with a total value claimed of a little over nine million and a total paid of a little under four million. Customer service received 380 complaints about claims, most of them about the time taken and the lack of updates.

The new application will give every claim a single record from first notification to final settlement and recovery, apply the business rules consistently, route decisions to the right approver, keep the customer informed, and give finance and management the reporting they need. The first release covers claims from business customers on the domestic road network. International shipments and the consumer parcel service are not included.

## 2. Background

### 2.1 The claims process today

A claim usually begins when a customer emails the claims mailbox or telephones customer service after a delivery that was damaged, short or did not arrive. Customer service passes telephone claims to the mailbox by email. A handler on the relevant regional desk picks up the email, creates a row in the desk's spreadsheet, and writes to the customer asking for the documents the desk needs, typically the commercial invoice for the goods, photographs of the damage, the signed delivery note and a statement of the amount claimed.

When the documents arrive the handler checks the consignment in the operational system to see where it was handled, whether any exceptions were recorded at the depots, and who signed for it at delivery. If a subcontracted haulier carried the consignment on any leg, the handler notes the haulier's name for a later recovery. The handler then decides whether Northgate is liable, works out the amount payable under the customer's terms, and asks a team leader to approve any payment above their own authority. Once approved, the handler emails finance with the payment details, and finance raises the payment manually.

Recoveries from hauliers are pursued separately by a two-person recovery team who work from a monthly extract of the desks' spreadsheets. Insurance claims are made by the finance team once a quarter for losses above the policy excess. There is no link between a customer claim and the recovery or insurance claim that relates to it, so the business cannot see the net cost of a claim.

### 2.2 Problems with the current process

The review of closed claims and the interviews identified the following problems. They are recorded here because they explain the requirements that follow.

- The time from first notification to settlement averages 47 days and in a fifth of cases exceeds 90 days.
- Around one claim in ten is paid without the supporting documents the desk's own checklist asks for.
- Handlers apply different interpretations of the limitation of liability in the standard conditions of carriage, so similar claims are settled for different amounts.
- About a third of the recoveries that could have been made from subcontracted hauliers are never pursued, usually because the time limit in the subcontract has passed by the time the recovery team sees the claim.
- Customers are not told what is happening to their claim unless they chase it.
- Finance cannot reconcile the payments made against the claims recorded, and the quarterly insurance claim takes the finance team about a week to prepare.

### 2.3 Goals

The business has set the following goals for the first year after go-live. They are business outcomes, not requirements on the application, but several requirements exist so that the outcomes can be measured.

- Reduce the average time to settle a claim to 30 days.
- Ensure every claim is settled under the documented limitation rules.
- Pursue a recovery on every claim where a subcontracted haulier carried the consignment and the amount exceeds the recovery threshold.
- Send customers proactive status updates at each stage of their claim.
- Produce the quarterly insurance claim from the application in under a day.

## 3. Scope

### 3.1 In scope for the first release

- Claims for loss, damage, shortage and delay from business customers on the domestic road network.
- Registration of claims by claims handlers from emails, telephone calls passed on by customer service, and the customer claim form.
- Document collection, liability assessment, calculation of the amount payable, approval, payment instruction and closure.
- Recovery from subcontracted hauliers and the preparation of insurance claims.
- Customer notifications and management reporting.

### 3.2 Out of scope for the first release

- A self-service portal in which customers register and track their own claims. This was in the previous version of this document and has been moved to a later release.
- International shipments, which are governed by different conventions and handled by the international desk.
- The consumer parcel service, which has its own compensation scheme.
- Claims against Northgate by third parties for injury or property damage, which are handled by the legal department and the insurer.
- Changes to the operational consignment tracking system, which will be read but not changed.

## 4. Definitions

- Claim: a request by a customer for compensation for one or more consignments that were lost, damaged, delivered short or delivered late.
- Consignment: a shipment carried under one consignment note, which may contain several packages.
- Claimant: the customer who makes the claim, who is normally the party that paid for the carriage.
- Standard conditions: Northgate's published conditions of carriage, which limit liability per kilogram of goods lost or damaged unless the customer has agreed different terms.
- Special terms: contract terms agreed with a particular customer that replace or vary the standard conditions.
- Declared value: a value the customer declared for a consignment when booking, for which an additional charge was paid, raising the limit of liability.
- Recovery: an amount Northgate seeks from a subcontracted haulier or other party responsible for a loss.
- Handler: a member of a regional claims desk who manages claims.
- Approver: a person with authority to approve a settlement above a handler's limit.

## 5. Claim registration

### 5.1 Notification

Claims reach Northgate in several ways, and the business wants all of them recorded in one place from the start.

[[R1 A handler shall be able to register a claim from an email, a telephone note passed on by customer service, or a completed claim form, and the application shall record the channel and the date and time the claim was first notified.]]

[[R2 The application shall require the consignment note number when a claim is registered and shall retrieve the consignment's details from the operational tracking system, including the collection and delivery dates, the depots it passed through, any exceptions recorded and the proof of delivery.]]

[[R3 If the consignment note number cannot be found in the tracking system, the handler shall be able to register the claim with the consignment marked as unverified, and the application shall prevent any payment on the claim until the consignment has been verified.]]

[[R4 A single claim shall be able to cover several consignments for the same claimant, and the application shall record the loss type and amount claimed separately for each consignment.]]

[[R5 The application shall warn the handler when a new claim is registered for a consignment that already has an open or closed claim, and shall show the existing claim.]] The review found eleven cases of the same loss being paid twice.

### 5.2 Time limits for notification

The standard conditions require the claimant to give notice of damage or shortage within a set time after delivery, and notice of loss within a set time after the expected delivery date.

[[R6 The application shall calculate, for each consignment on a claim, whether the claim was notified within the time limit in the claimant's terms, and shall flag any claim notified late.]]

[[R7 Under the standard conditions, damage and shortage must be notified within 7 days of delivery and loss within 28 days of the expected delivery date.]] Special terms may set different periods, and some large customers have negotiated longer periods.

[[R8 A late-notified claim shall not be rejected automatically; the handler shall record whether the time limit is being enforced and, if it is waived, the reason for the waiver.]] Commercial managers sometimes ask for the time limit to be waived for important customers.

## 6. Documents and evidence

### 6.1 Required documents

The documents required depend on the loss type and the amount claimed. Today the checklist is a laminated sheet on each desk and it is applied inconsistently.

[[R9 The application shall maintain the list of documents required for each loss type, and the claims operations manager shall be able to change the list without a software release.]]

[[R10 When a claim is registered, the application shall generate a request to the claimant listing the documents required for each consignment on the claim.]]

[[R11 A handler shall be able to attach documents to a claim from email, from a file, or by forwarding an email to a claim-specific address, and the application shall record who attached each document and when.]]

[[R12 The application shall not allow a claim to proceed to approval until every required document has been received or the handler has recorded why it is not needed.]]

[[R13 If the required documents have not been received 21 days after the request, the application shall send a reminder to the claimant, and if they have still not been received 21 days after the reminder, the claim shall be closed as abandoned.]] An abandoned claim can be reopened if the documents arrive later.

### 6.2 Photographs and inspection

For damage claims, photographs are usually enough. For high-value claims the business sometimes sends an independent surveyor to inspect the goods.

[[R14 The handler shall be able to request an independent inspection for a damage claim, record the surveyor appointed, and attach the surveyor's report.]]

[[R15 An inspection shall be requested for every damage claim on a high-value consignment before liability is decided.]] The legal department asked for this following two disputed settlements last year.

## 7. Liability assessment

### 7.1 Determining liability

Northgate is liable for loss and damage that occurs while goods are in its care, subject to the exceptions in the conditions of carriage, such as inadequate packaging by the customer or inherent defects in the goods.

[[R16 The handler shall record a liability decision for each consignment on a claim, chosen from accepted, partly accepted or declined, with a reason chosen from a list maintained by the claims operations manager.]]

[[R17 Where the liability decision is declined or partly accepted on the grounds of inadequate packaging, the handler shall attach the evidence supporting that decision before the decision can be saved.]]

[[R18 The application shall show the handler the depot exceptions recorded for the consignment, so that the handler can see where in the network the loss or damage was first recorded.]]

[[R19 Where the consignment was carried by a subcontracted haulier on any leg, the application shall identify the haulier and the leg from the tracking system and shall record them on the claim.]]

### 7.2 Limitation of liability

The amount Northgate pays is the lower of the value of the loss and the limit of liability that applies to the consignment. The rules for working out the limit have been a major source of inconsistency.

[[R20 The application shall calculate the limit of liability for each consignment from the weight of the goods lost or damaged and the per-kilogram limit in the claimant's terms.]]

[[R21 Where the claimant declared a value for the consignment and paid the declared value charge, the limit of liability shall be the declared value instead of the per-kilogram limit.]]

[[R22 Where special terms apply, the application shall use the limits in the special terms, and the handler shall not be able to override the calculated limit without the approval of the claims operations manager.]]

[[R23 The amount payable for a consignment shall be the lower of the proven value of the loss and the limit of liability, less any salvage value recovered from damaged goods.]]

[[R24 The application shall show the handler how the amount payable was calculated, step by step, and the same explanation shall be included in the settlement letter to the claimant.]] Customer service believes many complaints arise because claimants do not understand why they were paid less than they claimed.

[[R25 Consequential losses, such as lost profit or the cost of a missed production run, shall not be payable under the standard conditions, and the application shall prevent a handler from including them in the amount payable unless special terms allow them.]]

### 7.3 Delay claims

Claims for delay are less common and are handled differently because Northgate does not guarantee delivery times under the standard conditions.

[[R26 A delay claim shall only be payable where the claimant had a guaranteed delivery service, and the amount payable shall not exceed the carriage charge for the consignment.]]

## 8. Approval and settlement

### 8.1 Approval matrix

Payments are approved by people with the authority to commit the amount. The matrix below replaces the informal arrangements on each desk.

| Total amount payable on the claim | Who can approve |
|---|---|
| Up to 1,000 | [[R27 The handler managing the claim can approve a settlement of up to 1,000.]] |
| From 1,000 to 10,000 | [[R28 A team leader on the regional desk must approve a settlement from 1,000 to 10,000.]] |
| From 10,000 to 50,000 | [[R29 The claims operations manager must approve a settlement from 10,000 to 50,000.]] |
| Above 50,000 | [[R30 The finance director must approve a settlement above 50,000, after review by the legal department.]] |

[[R31 The application shall route each settlement to the approver required by the matrix and shall not allow a person to approve a settlement on a claim they registered or handled.]]

[[R32 The approval limits in the matrix shall be configurable by the claims operations manager, and every change shall be recorded with the name of the person who made it and the date.]]

Approvers are expected to deal with approvals promptly so that settlement times can be met.

### 8.2 Settlement and payment

[[R33 Once a settlement is approved, the application shall generate a settlement letter to the claimant showing the amount payable for each consignment and how it was calculated.]]

[[R34 The application shall send an approved payment to the finance ledger as a payment instruction with the claimant's account details, and shall record the payment reference when finance confirms the payment.]] Finance will continue to make the payment itself through the ledger.

[[R35 A claimant shall be able to accept the settlement or dispute it, and a disputed settlement shall return to the handler with the claimant's reasons.]]

[[R36 A claim shall be closed when every consignment on it has been paid, declined or withdrawn, and the application shall record the closing date and the outcome for each consignment.]]

## 9. Recovery and insurance

### 9.1 Recovery from subcontracted hauliers

Subcontract agreements allow Northgate to recover from a haulier the amount paid for a loss that happened while the haulier had the goods, subject to the haulier's own limits and a time limit for making the recovery claim.

[[R37 When a claim is settled for a consignment carried by a subcontracted haulier, the application shall create a recovery case linked to the claim if the amount paid exceeds the recovery threshold.]]

[[R38 The recovery case shall show the time limit for making the recovery claim under the haulier's subcontract and shall alert the recovery team 14 days before it expires.]]

[[R39 The recovery team shall be able to record the amount claimed from the haulier, the haulier's response, and the amount recovered, and the application shall show the net cost of the original claim after recovery.]]

[[R40 The recovery team shall be able to deduct an agreed recovery amount from the next payment to the haulier, and the application shall send the deduction to the finance ledger as an instruction.]]

### 9.2 Insurance

[[R41 The application shall identify every settled claim whose amount paid exceeds the insurance policy excess and shall produce, for any period, the schedule of those claims in the format the insurer requires.]]

[[R42 The application shall record the amount recovered from the insurer against each claim in the schedule.]]

## 10. Customer communication

The complaint log shows that the lack of updates is the single biggest source of dissatisfaction with the claims process.

[[R43 The application shall send the claimant an email when their claim is registered, when documents are requested, when liability is decided, when a settlement is approved and when the claim is closed.]]

[[R44 Every message to the claimant shall quote the claim reference and the name of the handler managing the claim, and shall be sent from an address to which the claimant can reply.]]

[[R45 Replies from claimants shall be attached to the claim automatically and the handler shall be notified.]]

[[R46 Customer service staff shall be able to see the status of any claim and its history of messages, but shall not be able to change a claim.]]

## 11. Reporting

Management reporting today is assembled by hand from the regional spreadsheets. The application must provide it directly.

[[R47 The application shall report, for any period and by region, the number of claims notified, the number settled, the average time from notification to settlement, the total amount claimed, the total amount paid and the total amount recovered.]]

[[R48 The application shall report the claims that have been open for more than 30 days, with the stage each one is at and how long it has been at that stage.]]

[[R49 The application shall report recovery cases whose time limit expires in the next 30 days and have not yet been submitted to the haulier.]]

[[R50 Finance shall be able to reconcile the payments recorded in the ledger against the settlements approved in the application for any period.]]

## 12. Data, security and audit

[[R51 Access to claims shall be restricted by role, and handlers shall see the claims of every region so that work can be moved between desks when one is busy.]]

[[R52 Every change to a claim, including changes to amounts, liability decisions and approvals, shall be recorded with the person who made it and the date and time, and the record shall not be editable.]]

[[R53 Claim records and their documents shall be retained for seven years after the claim is closed and then deleted, unless the claim is subject to litigation.]]

Documents attached to claims can include invoices that show customers' prices and occasionally photographs that include people. The legal department has asked that access to documents be no wider than access to claims.

## 13. Migration

The regional spreadsheets hold around 900 open claims at any one time. They need to be moved into the application at go-live so that the desks do not run two processes in parallel.

[[R54 All claims open on the regional spreadsheets at go-live shall be migrated into the application with their status, amounts and the documents held in the mailbox.]]

[[R55 Claims closed in the twelve months before go-live shall be migrated so that duplicate claim warnings and reporting cover them.]]

## 14. Non-functional requirements

[[R56 The application shall be available during the claims desks' working hours, from 7am to 7pm on working days, at least 99.5% of the time.]]

[[R57 The application shall support at least 40 concurrent users without any page taking more than three seconds to load.]]

[[R58 The application shall be usable by handlers working from home through the company's standard remote access arrangements.]]

## 15. Business rules summary

For convenience this section restates the main time limits used in the claims process. Where this summary and the capability sections differ, the capability sections take precedence. This summary was prepared for the finance team before the time limits were reviewed by legal.

| Rule | Limit |
|---|---|
| Notice of damage or shortage | [[A1 Within 14 days of delivery]] |
| Notice of loss | Within 28 days of the expected delivery date |
| Documents reminder | 21 days after the request |
| Claim closed as abandoned | 21 days after the reminder |
| Recovery time-limit alert | 14 days before expiry |

## 16. Assumptions, dependencies and open questions

### 16.1 Assumptions

- The operational tracking system can be queried by consignment note number and returns depot exceptions and proof of delivery.
- The finance ledger accepts payment instructions from another application through its existing import.
- The insurer will accept the claims schedule as a spreadsheet in the format it uses today.

### 16.2 Open questions

- [[A2 The recovery threshold below which a recovery is not worth pursuing has not been agreed between finance and the recovery team.]]
- [[A3 The definition of a high-value consignment for the purpose of mandatory inspection is still to be agreed with the legal department.]]
- Whether customer service may register claims directly, rather than passing them to the mailbox, has been raised but not decided.

<!-- labels
A1 [conflict] @R7: the business rules summary gives 14 days for notice of damage and shortage while R7 gives 7 days; the summary says the capability sections take precedence but also that it predates legal review => Is the notice period for damage and shortage 7 days or 14 days after delivery?
A2 [tbd] @R37: the recovery threshold that triggers a recovery case is not defined => What claim amount must be exceeded before a recovery case is created against a haulier?
A3 [undefined-term] @R15: "high-value consignment" is used as the trigger for mandatory inspection but is never defined => What makes a consignment high-value for mandatory inspection: the amount claimed, a declared value, the goods type, or something else?
A4 [vague-term] @R31: approvers are to deal with approvals "promptly", with no target time and no escalation when they do not => How quickly must an approver act on a settlement, and what happens when they do not?
A5 [conflict] @R27,R28: the approval bands overlap at exactly 1,000, 10,000 and 50,000, so it is unclear who approves a settlement of exactly those amounts => Who approves a settlement of exactly 1,000, 10,000 or 50,000?
A6 [missing] @R35: a disputed settlement returns to the handler, but nothing says whether it needs re-approval, how many times it can be disputed, or when a dispute ends => After a claimant disputes a settlement, does a revised offer need approval again, and is there a limit on disputes or a final position?
A7 [missing] @R13,R36: a claim closed as abandoned can be reopened, but there is no rule on how late it can be reopened or whether the notification time limits still apply => Is there a deadline after which an abandoned claim can no longer be reopened?
A8 [conflict] @R51,R46: handlers see every region's claims, while legal asks that document access be no wider than claim access and the role model is not described; it is unclear whether customer service sees documents => Which roles may see the documents attached to a claim, including invoices and photographs of people?
A9 [missing] @R4,R31: a claim covers several consignments but the approval matrix uses the total amount on the claim; it is not said whether splitting consignments across claims is prevented => Should the approval level be based on the claim total, and how is a claim split into several claims to stay under a limit prevented?
A10 [missing] @R40,R39: deducting a recovery from a haulier's next payment has no stated rule for a disputed recovery or a haulier with no further payments due => Can a recovery be deducted from a haulier's payment while the haulier disputes it, and what happens when no further payment is due?
A11 [tbd] @R1: whether customer service may register claims directly is undecided, which changes who can perform R1 => May customer service staff register claims themselves, or must they continue to pass them to the claims mailbox?
A12 [conflict] @R26,R25: delay claims are payable up to the carriage charge with a guaranteed service, while consequential losses are excluded; the document does not say whether delay compensation counts as a consequential loss under special terms => For a delay claim under special terms, is compensation still capped at the carriage charge, and is any delay loss treated as consequential?
-->
