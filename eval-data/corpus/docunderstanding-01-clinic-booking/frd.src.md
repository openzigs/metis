# Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

## Document control

This document describes the functional requirements for the online appointment booking portal that Riverside Community Clinics intends to offer to its registered patients. It was prepared by the Patient Access business analysis team after a series of workshops with front-desk staff, practice managers, two clinical leads and a patient representative group. Version 0.9 is the draft circulated for review by the steering group. Comments should be returned to the Patient Access team before the steering group meeting at the end of the month. Once approved, this document will be the basis for vendor configuration and for the acceptance testing plan.

The document is organised by business capability rather than by screen. Each requirement is written as a statement of what the portal or the clinic's staff must be able to do. Where a requirement depends on a decision that has not yet been made, the open point is listed in the final section. Background material is included to help readers outside the Patient Access team understand why a requirement exists; it does not in itself add requirements.

## 1. Background and business context

Riverside Community Clinics operates six neighbourhood clinics across the river district, offering general practice, nurse-led chronic disease reviews, childhood immunisations, travel health and a small physiotherapy service. Around 41,000 patients are registered across the six sites. Today almost every appointment is booked by telephone. Patients report long waits on the phone line in the first hour after opening, and front-desk staff spend a large share of their morning answering calls rather than greeting patients who are physically present.

A patient survey carried out last spring found that two thirds of respondents would prefer to book routine appointments online, and that the most common reason for missed appointments was that the patient had forgotten. The clinics recorded just over 9,000 missed appointments in the last financial year, which the finance team estimates as a significant loss of clinical capacity. The board has therefore approved a project to introduce online self-service booking, automated reminders and a simple waiting list, with the twin goals of reducing telephone demand and reducing missed appointments.

The clinics already use a practice management system, referred to in this document as the PMS, which holds the patient register, clinician rotas and the appointment book. The PMS remains the system of record for appointments. The portal is a patient-facing layer that reads availability from the PMS and writes bookings back to it. The PMS vendor exposes an integration interface that the portal will use; the technical details of that interface are outside the scope of this document.

### 1.1 Business objectives

The project has four objectives that the steering group has agreed:

- Reduce the volume of inbound booking calls in the first two hours of opening by at least a third within six months of launch.
- Reduce missed appointments by a fifth within twelve months of launch.
- Give patients a way to see, book, change and cancel routine appointments at any time of day.
- Give front-desk staff a single view of online bookings alongside telephone bookings so that nothing is managed twice.

These objectives are measured by the clinics' existing operational reports and are not themselves functional requirements of the portal, although the reporting section below describes the data the portal must provide so that progress can be tracked.

### 1.2 Stakeholders

The main stakeholder groups are registered patients and their authorised carers, front-desk and reception staff, practice managers at each site, clinicians whose time is booked through the portal, the clinics' information governance lead, and the IT service desk that will support the portal once it is live. A patient representative group of eleven volunteers has reviewed the patient-facing parts of this document and will take part in usability testing.

### 1.3 How booking works today

A patient who wants a routine appointment telephones their registered site. The call is answered by whichever receptionist is free, who asks for the patient's name and date of birth, finds them in the PMS, and asks what the appointment is for in general terms. The receptionist then looks for a suitable slot in the appointment book, offers one or two options, and books the one the patient accepts. If no slot is available in the next fortnight the patient is asked to call back on another day, because there is no waiting list. Receptionists estimate that a routine booking call takes between three and five minutes, and longer when the patient is booking for a relative whose details they do not have to hand.

Cancellations arrive by telephone, by email to the site inbox, and occasionally in person. Each site handles its inbox differently; at two sites it is checked only at the end of the day, which means a slot cancelled by email in the morning is often not re-offered. Reminders are sent by the PMS for some appointment types only, as a text message on the day before, and patients cannot reply to them. Practice managers do not have a reliable picture of how many cancelled slots are re-used.

Carers book for dependants informally. A receptionist who recognises a parent's voice will usually book for the child without further checks. For adult dependants the practice relies on staff knowing the family. The information governance lead has identified this as a risk that the portal should not reproduce.

### 1.4 How booking will work

Once the portal is live, a patient will sign in, choose the appointment type, see the free slots at their site for the next few weeks, pick one, give a short reason and confirm. The booking appears in the PMS immediately and the receptionist sees it in the same appointment book as a telephone booking. The patient receives a confirmation and, nearer the time, a reminder they can reply to if they need to cancel. A cancelled slot is offered automatically to patients on the waiting list who said they could attend at that time.

Telephone booking will continue for patients who prefer it, for urgent and same-day appointments, and for appointment types that are not offered online. The clinics expect telephone demand to fall but not to disappear, and the receptionists' role will shift towards helping patients who cannot or do not want to use the portal. [[R45 Receptionists shall be able to see, for any patient, whether the patient has a portal account and whether it is locked, so that they can direct the patient appropriately.]]

The project team considered and rejected an approach in which the portal kept its own copy of the appointment book and synchronised it with the PMS overnight. That approach would have been simpler to build but would have made double booking likely and would have left receptionists working from two views. [[R46 The portal shall not keep its own copy of the appointment book; every availability search and booking shall be made against the PMS.]]

## 2. Scope

### 2.1 In scope

The first release covers routine, non-urgent appointment types that the practice managers have marked as bookable online. At launch these are expected to include routine general practitioner consultations, nurse appointments for blood pressure and diabetes reviews, childhood immunisations, travel health consultations and physiotherapy follow-ups. Each site may choose which of its appointment types are offered online.

The first release includes patient sign-in, viewing availability, booking, rescheduling and cancelling appointments, appointment reminders, a waiting list for cancelled slots, carer access for dependants, a staff view of online activity, and the reports described in section 8.

### 2.2 Out of scope

The following are explicitly out of scope for the first release: video consultations, repeat prescription requests, access to medical records or test results, online payment for travel vaccines, and booking appointments with external providers such as hospital outpatient departments. Urgent and same-day appointments remain telephone-only in the first release because the clinics triage those calls clinically. The portal will not offer a symptom checker or any form of clinical advice.

## 3. Glossary

- Appointment type: a category of appointment defined in the PMS, such as a routine GP consultation, with a standard duration and a list of clinicians who can deliver it.
- Slot: a period in a clinician's rota that can hold one appointment of a given type.
- Bookable online: a flag that a practice manager sets on an appointment type at a site to make its slots visible in the portal.
- Carer: a person who is authorised to book on behalf of another patient, such as a parent for a child.
- Dependant: a patient for whom a carer is authorised to book.
- Waiting list: a list of patients who have asked to be offered an earlier slot of a particular appointment type if one becomes free.
- Hold: a short reservation of a slot while a patient completes a booking.

## 4. Patient access and identity

Patients must already be registered at one of the six clinics to use the portal. Registration itself is not part of the portal; new patients continue to register in person or through the existing paper form.

[[R1 A registered patient shall be able to create a portal account by verifying their identity against the details held in the PMS, using their date of birth, surname, postcode and a one-time code sent to the mobile number held in the PMS.]] The one-time code is the patient's evidence that they control the phone number the clinic already holds for them, which the information governance lead considers sufficient for booking access but not for record access.

[[R2 If a patient has no mobile number recorded in the PMS, the portal shall tell the patient to contact their clinic and shall not offer any other way to verify their identity online.]]

[[R3 A patient shall sign in with an email address and password, and the portal shall require a second factor on every sign-in from a device it has not seen before.]] Patients told the representative group that they did not want to enter a code every time they booked, so the second factor is only required on new devices.

[[R4 The portal shall lock an account after five consecutive failed sign-in attempts and shall unlock it automatically after thirty minutes.]] Front-desk staff will not be able to unlock accounts manually in the first release; this was discussed and deliberately left out to avoid creating a social engineering route.

[[R5 A signed-in session shall end after a period of inactivity, and the patient shall be warned before it ends.]] The workshop did not reach a conclusion on how long the period should be.

### 4.1 Carers and dependants

Many bookings are made by parents for children and by adult children for elderly parents. Today this happens informally over the phone. The portal formalises it.

[[R6 A carer shall be able to book, reschedule and cancel appointments for any dependant linked to their account.]]

[[R7 A link between a carer and a dependant shall only be created by front-desk staff after they have checked the carer's authority, and the portal shall not let a patient create such a link themselves.]]

[[R8 A carer link for a dependant under the age of sixteen shall end automatically on the dependant's sixteenth birthday, and the portal shall notify the carer thirty days beforehand.]] [[A1 Links for adult dependants, for example a patient with a lasting power of attorney in place, are reviewed periodically.]]

## 5. Viewing availability and booking

### 5.1 Finding a slot

[[R9 The portal shall show a patient only the appointment types that are marked as bookable online at the patient's registered site.]] Patients registered at one site can be seen at another site for some services, such as physiotherapy, which is only offered at two sites.

[[R10 For physiotherapy follow-ups and travel health consultations, the portal shall also offer slots at the other sites that deliver those services.]]

[[R11 The portal shall show availability for the next four weeks and shall let the patient filter by site, clinician, day of the week and time of day.]] The practice managers asked for the window to be short so that clinicians' rotas can still change without moving many booked appointments.

[[R12 Availability shown in the portal shall reflect the PMS appointment book in near real time.]] Front-desk staff are concerned that a slot booked by telephone might still appear free in the portal and be booked twice.

[[R13 When a patient selects a slot, the portal shall place a hold on it for five minutes so that no other patient or staff member can book it while the patient completes the booking.]] If the patient does not confirm within the hold period the slot is released.

### 5.2 Booking rules

Some rules exist to protect clinical capacity and to keep the appointment book fair between patients who book online and those who telephone.

[[R14 A patient shall not hold more than two future routine GP appointments at the same time across all sites.]] This limit does not apply to nurse reviews, immunisations or physiotherapy, which are often booked as a series.

[[R15 The portal shall not allow a booking that starts less than two hours from the current time.]] Short-notice slots are kept for the telephone triage team.

[[R16 Childhood immunisation appointments shall only be bookable by a carer for a dependant whose age is within the range set for that immunisation type in the PMS.]]

[[R17 Before confirming a booking, the portal shall ask the patient to state the reason for the appointment in a free-text field of up to 200 characters, which shall be passed to the PMS with the booking.]] The clinical leads asked for this so that clinicians can prepare. Patients will be told that the field is not monitored and that urgent problems must be telephoned in.

[[R18 The portal shall show a clear warning on every booking screen that it must not be used for urgent medical problems, with the telephone number of the clinic and the national urgent care number.]]

[[R19 When a booking is confirmed, the portal shall write it to the PMS and shall show the patient a confirmation only after the PMS has accepted it.]] [[A2 If the PMS is unavailable, the booking should be handled appropriately.]]

### 5.3 Rescheduling and cancelling

[[R20 A patient shall be able to cancel an appointment through the portal up to two hours before its start time.]] This matches the two-hour short-notice rule so that freed slots can be offered to the telephone triage team.

[[R21 A patient shall be able to move an appointment to another slot of the same appointment type, and the original slot shall only be released once the new booking has been accepted by the PMS.]]

[[R22 The portal shall ask a patient who cancels to choose a reason from a list maintained by the practice managers.]] Reasons are used in reporting to understand why appointments are cancelled.

[[R23 Appointments booked by telephone shall be visible in the portal and shall be cancellable by the patient in the same way as appointments booked online.]]

## 6. Reminders and notifications

Missed appointments are the second business objective of the project. The reminder service is the main tool for addressing them.

[[R24 The portal shall send each patient a reminder by text message 48 hours before every appointment, whether it was booked online or by telephone.]] The finance team's analysis suggests most missed appointments are booked more than a week in advance, so an early reminder is the most effective intervention.

[[R25 A reminder shall let the patient cancel the appointment by replying to the message or by following a link, without signing in.]] Cancelling through a reminder releases the slot in the same way as cancelling in the portal.

[[R26 The portal shall send a confirmation by email when an appointment is booked, moved or cancelled, to the email address on the account that made the change.]] Where a carer makes the change, the confirmation goes to the carer.

[[R27 Patients shall be able to choose not to receive text reminders, and the choice shall be recorded in the PMS so that it also applies to reminders the PMS sends.]]

The following table summarises the notifications. It repeats some of the statements above for convenience and adds the timing of the morning-of reminder requested by the physiotherapy team.

| Event | Channel | Timing | Recipient |
|---|---|---|---|
| Appointment booked, moved or cancelled | Email | At the time of the change | The account holder who made the change |
| Upcoming appointment | Text message | [[A4 24 hours before the appointment]] | The patient, or the carer for a dependant |
| Physiotherapy follow-up on the day | Text message | [[R28 A same-day text reminder is sent at 7am for physiotherapy appointments starting after 10am.]] | The patient |
| Waiting list offer | Text message and email | When a matching slot is released | The patient on the waiting list |

## 7. Waiting list

When appointments are cancelled, the freed slots are often wasted because there is no quick way to offer them to someone else. The waiting list is intended to fill those slots.

[[R29 A patient who cannot find a suitable slot shall be able to join a waiting list for a chosen appointment type and site, stating the days of the week and times of day they could attend.]]

[[R30 When a slot of that appointment type is released at that site within the patient's stated availability, the portal shall offer it to patients on the waiting list in the order in which they joined.]]

[[R31 An offer shall expire if it is not accepted within a short period, and the slot shall then be offered to the next patient on the list.]] The workshop agreed that the period should be short enough that the slot can still be filled.

[[R32 A patient shall be removed from a waiting list once they accept an offer, book a matching appointment themselves, or after 60 days, whichever comes first.]]

## 8. Staff functions and reporting

Front-desk staff and practice managers use the PMS for most of their work. The portal adds a small staff area for the functions that only exist because of online booking.

[[R33 Practice managers shall be able to mark or unmark each appointment type at their own site as bookable online, and the change shall take effect in the portal within fifteen minutes.]]

[[R34 Front-desk staff shall be able to see a list of the day's online bookings, cancellations and waiting list offers for their site, with the reason for appointment given by each patient.]]

[[R35 Front-desk staff shall be able to suspend online booking for a single clinician for a date range, for example during unplanned leave, without changing the PMS rota.]]

[[R36 The portal shall provide a monthly report for each site showing the number of appointments booked, moved and cancelled online, the number of reminders sent, and the number of missed appointments for online and telephone bookings separately.]] The report is used by the steering group to track the business objectives in section 1.1.

## 9. Non-functional requirements

### 9.1 Availability and performance

[[R37 The portal shall be available at least 99.5% of the time in each calendar month, excluding planned maintenance announced at least five days in advance.]]

[[R38 Availability searches shall return results within three seconds for 95% of requests at peak load.]] Peak load is expected on weekday mornings between 7:30 and 9:30.

### 9.2 Accessibility and language

[[R39 The patient-facing portal shall meet the WCAG 2.2 AA accessibility standard.]] The patient representative group includes members who use screen readers and screen magnifiers, and they will be part of usability testing.

[[R40 The portal shall be available in English and in the other languages most commonly spoken by registered patients, where possible.]] The practice managers believe Polish, Urdu and Somali are the most common, but this has not been confirmed from registration data.

### 9.3 Privacy, security and data retention

[[R41 The portal shall store only the personal data needed to sign patients in and to send reminders, and shall read all other patient details from the PMS when they are needed.]]

[[R42 Every booking, change and cancellation made through the portal shall be recorded in an audit log showing who made it, on whose behalf, and when.]]

[[R43 Audit log entries shall be kept for eight years and shall not be editable by any user, including system administrators.]]

[[R44 Portal accounts that have not been used for two years shall be deleted, and the patient shall be warned by email thirty days before deletion.]] Deleting a portal account does not affect the patient's record in the PMS.

## 10. Assumptions and dependencies

The following assumptions have been made in preparing this document. If any of them proves false, the affected requirements will need to be revisited.

- The PMS vendor's integration interface supports reading availability, creating and cancelling appointments, and writing the reason for appointment.
- Every site keeps its clinician rotas in the PMS at least four weeks ahead.
- The clinics' existing text message provider can be used for reminders and one-time codes, and supports replies.
- Information governance approval for the portal's data processing will be granted before launch.

## 11. Open issues

The following points were raised during the workshops and are not yet resolved. They are listed so that reviewers can comment on them.

- The length of the inactivity period after which a session ends has not been agreed. Information governance suggested ten minutes; the patient representatives felt this was too short.
- [[A3 The expiry period for waiting list offers is to be confirmed by the practice managers.]]
- [[A10 Whether patients registered at one site may book routine GP appointments at another site has been discussed but not decided.]] Two practice managers were in favour and four were against.
- [[A11 The clinical leads have asked whether the reason for appointment should be visible to front-desk staff at all.]] The staff list described in section 8 assumes that it is.

<!-- labels
A1 [missing] @R7: the document says adult carer links are reviewed periodically but never says how often, by whom, or what happens to the link when a review is not done => How often are carer links for adult dependants reviewed, who reviews them, and does the link lapse if the review is missed?
A2 [vague-term] @R19: the behaviour when the PMS is unavailable is left as "handled appropriately", so it is unclear whether the portal refuses the booking, queues it or shows a slot it cannot confirm => When the PMS is unavailable, should the portal refuse new bookings, queue them for later, or stop showing availability?
A3 [tbd] @R31: the waiting list offer expiry period is undefined; R31 says only "a short period" => How long does a patient have to accept a waiting list offer before it passes to the next person?
A4 [conflict] @R24: R24 says the text reminder is sent 48 hours before every appointment, while the notification table says 24 hours => Is the standard text reminder sent 48 hours or 24 hours before the appointment, or both?
A5 [vague-term] @R12: "near real time" is not quantified, and staff are worried about double booking => What is the longest acceptable delay between a telephone booking in the PMS and the slot disappearing from the portal?
A6 [tbd] @R5: the inactivity timeout is not agreed (ten minutes was suggested and disputed) => How long can a signed-in session stay inactive before it ends, and how far in advance is the warning shown?
A7 [escape-clause] @R40: "where possible" makes the language requirement unverifiable and the language list is unconfirmed => Which languages must the portal support at launch, and is that a firm requirement or an aspiration?
A8 [conflict] @R20,R25: cancelling in the portal stops two hours before the start, but a reminder reply or link can cancel without any stated cut-off => Does the two-hour cancellation cut-off also apply to cancellations made by replying to a reminder?
A9 [missing] @R14,R23: the two-appointment GP limit is stated for portal bookings, but the document is silent on whether telephone bookings count towards it => Do routine GP appointments booked by telephone count towards the limit of two future appointments?
A10 [tbd] @R9,R10: the document does not decide whether a patient may book routine GP appointments at a site other than their registered one; R9 implies not, and the open issue says it is undecided => May a patient book a routine GP appointment at a site other than the one they are registered at?
A11 [conflict] @R17,R34: R34 shows the reason for appointment to front-desk staff, while the clinical leads question whether staff should see it at all, and patients are told it is for clinicians => Should front-desk staff see the reason for appointment a patient enters, or only clinicians?
-->
