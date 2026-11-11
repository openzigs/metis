# Harbour City Council: Community Grants Management System, Functional Requirements Document

## About this document

This functional requirements document describes the system Harbour City Council needs to run its community grants programmes, from the publication of a funding round to the final monitoring report of a funded project. It replaces the requirements section of the outline business case approved by the council's Resources Committee and is intended to be used by the procurement team to evaluate suppliers, by the chosen supplier to configure the system, and by the Community Investment team to plan acceptance testing.

The document was written by the council's Digital Services business analysts with the Community Investment team, the Finance service, Legal Services, the Information Governance team, the Equality and Inclusion officer and representatives of three voluntary sector umbrella bodies who tested the current application process with their members. It reflects the council's grants policy as approved by Cabinet earlier this year. Where the policy is quoted it is summarised; the policy document itself remains the authority on eligibility and conditions.

Readers who are not familiar with council grant-making should read sections 1 to 3 first. Sections 4 onwards describe what the system must do, grouped by stage of the grant lifecycle. Each stage begins with a short description of the business process, followed by the requirements for that stage. Section 13 lists the reports, section 14 the non-functional requirements and section 16 the open questions that remain.

## 1. Introduction

### 1.1 The council's grant programmes

Harbour City Council gives around 4.2 million a year in grants to voluntary and community organisations, social enterprises and, in a small number of programmes, individuals. The money is distributed through seven programmes, each with its own purpose, budget and eligibility rules. The largest is the Neighbourhood Fund, which awards grants of between 1,000 and 25,000 to projects that improve life in a particular neighbourhood. The Strategic Partnerships programme awards multi-year grants of up to 150,000 a year to organisations that deliver services the council would otherwise have to commission. The remaining programmes are smaller: the Small Sparks fund for grants up to 1,000, the Youth Voice fund run with the youth council, the Arts in the Open fund, the Winter Warmth fund, and the Ward Member Grants scheme, through which each of the council's 48 elected members can recommend small grants in their own ward.

Each programme opens one or more funding rounds a year. A round has an opening date, a closing date, a budget and a set of assessment criteria. Some rounds are open to any eligible organisation; others are by invitation only. Ward Member Grants are not run as rounds but are open all year until each member's allocation is spent.

### 1.2 Why a new system is needed

The council runs its grants today with an online form builder, a shared drive, a spreadsheet for each programme and the finance system. Applications arrive as form submissions that officers download into the shared drive. Assessment scores are kept in spreadsheets that are emailed between assessors. Decisions are recorded in the minutes of panel meetings and then typed into the programme spreadsheet. Payments are requested from Finance by email, with the bank details copied by hand from the application form. Monitoring reports from funded organisations arrive by email and are often not read until the next application from the same organisation.

An internal audit of grant-making last year rated the control environment as limited. The audit found that conflicts of interest were not recorded consistently, that in a sample of 60 grants seven had been paid before the grant agreement was signed, that bank details had been changed on the strength of an email in two cases, and that the council could not say how much it had given to any one organisation across all programmes. The audit recommended a single system with built-in controls. The Resources Committee accepted the recommendation and approved the budget for this project.

Applicants have their own complaints. The voluntary sector umbrella bodies report that organisations must re-enter the same details for every application, that the form does not save partial progress reliably, that applicants are not told when their application has been received or when a decision will be made, and that unsuccessful applicants are rarely given feedback.

### 1.3 Objectives

The objectives agreed by the project board are:

- Bring every programme into one system, with one record for each applicant organisation.
- Address every recommendation in the internal audit report.
- Make applying simpler for small organisations, especially those run entirely by volunteers.
- Give officers and members accurate, up-to-date information about funding by programme, ward and organisation.
- Reduce the time officers spend on administration so they can spend more time supporting applicants.

## 2. Scope

### 2.1 In scope

The system will support all seven programmes and the full lifecycle of a grant: programme and round set-up, applicant registration, eligibility checking, application, assessment, decision, grant agreement, payment, variation, monitoring and closure. It will hold the council's record of every applicant organisation and every grant. It will be used by applicants, council officers in the Community Investment team, assessors (some of whom are external volunteers), decision-makers including panel members and Cabinet members, ward members for their own grants, Finance staff, and auditors.

### 2.2 Out of scope

The following are out of scope: grants made by the council to individuals under the welfare assistance scheme, which use a separate system; procurement of services, which follows the council's contract procedure rules; business rates relief; and grants the council receives from other funders. The finance system remains the system of record for payments and the council's bank account; the grants system will instruct payments but will not make them. The council's website content management system will continue to host the public pages about each programme.

### 2.3 Users

- Applicants: people applying on behalf of an organisation, or, in the Youth Voice fund, young people applying as a group.
- Grants officers: members of the Community Investment team who manage programmes, rounds and grants.
- Programme managers: senior officers responsible for a programme's budget and outcomes.
- Assessors: officers or external volunteers who score applications.
- Decision-makers: grant panels, the Cabinet member for communities, Cabinet, or a senior officer under delegated authority, depending on the programme and amount.
- Ward members: elected councillors who recommend Ward Member Grants.
- Finance officers: staff in the Finance service who check and release payments.
- Auditors: internal and external auditors with read-only access.

## 3. Glossary

- Applicant organisation: an organisation registered in the system that has applied, or may apply, for a grant.
- Main contact: the person an applicant organisation nominates as its point of contact for a grant.
- Round: a funding round of a programme, with opening and closing dates, a budget and assessment criteria.
- Eligibility check: a short set of questions that tells an applicant whether they can apply to a round before they start the full application.
- Assessment: the scoring of an application against a round's criteria by one or more assessors.
- Moderation: a meeting or review in which assessors' scores are compared and agreed.
- Grant agreement: the legal agreement between the council and a grant recipient that sets out the amount, the purpose, the conditions and the payment schedule.
- Variation: a change to a grant agreement after it has been signed.
- Monitoring report: a report by the grant recipient on the progress of the funded project.
- Clawback: the recovery by the council of all or part of a grant that was not used for its agreed purpose.
- Due diligence: the checks the council makes on an applicant organisation before it is offered a grant.

## 4. Programme and round set-up

Grants officers set up each round in the system before it opens. Today the details of a round are spread between a web page, the form builder and the programme spreadsheet, and they sometimes disagree.

[[R1 A grants officer shall be able to create a round for a programme, recording its opening and closing date and time, its budget, the minimum and maximum grant that can be requested, the eligibility questions, the application questions and the assessment criteria with their weightings.]]

[[R2 A round shall only be opened once its programme manager has approved its set-up, and the system shall record who approved it and when.]]

[[R3 The system shall not allow the budget of the rounds in a programme in one financial year to exceed the programme's budget for that year.]]

[[R4 A grants officer shall be able to copy a previous round as the starting point for a new one.]]

[[R5 A round may be open to all eligible applicants or by invitation only; for an invitation-only round, the system shall only let invited organisations start an application.]]

[[R6 Applications shall not be accepted after a round's closing date and time, and an application that is being completed when the round closes shall not be submittable.]] Grants officers sometimes extend the deadline for an individual applicant who had technical problems.

[[R7 The programme manager shall be able to extend the closing date for a single applicant, recording the reason, and the extension shall be shown in the round's audit history.]]

## 5. Applicant registration and organisation records

### 5.1 Registering an organisation

The council wants one record for each organisation it funds, so that it can see everything the organisation has applied for and received. Many small organisations change their main contact frequently, so the organisation record must not depend on one person.

[[R8 A person shall be able to register an organisation in the system by giving its name, address, legal form, charity or company number if it has one, and the details of at least two people connected with it who are not related to each other.]] The requirement for two unrelated people follows the council's grants policy, which does not fund organisations controlled by a single family.

[[R9 Where a charity or company number is given, the system shall check it against the public register and shall show the officer any difference between the registered name and address and those entered.]]

[[R10 The system shall prevent the registration of an organisation whose charity or company number is already held on another organisation record, and shall direct the person to request access to the existing record.]]

[[R11 An organisation record shall be able to have several users, and the organisation's existing users shall approve any request by a new user to join it.]]

[[R12 If an organisation has no remaining users who can approve a request, a grants officer shall be able to add a user after verifying the person's connection with the organisation.]]

### 5.2 Organisation documents

Applicants are asked for the same documents for every application: their governing document, their latest accounts, their safeguarding policy and their equality policy. The umbrella bodies say this is one of the most frustrating parts of applying.

[[R13 An organisation shall be able to upload its governing document, latest accounts, safeguarding policy and equality policy to its organisation record once, and the system shall attach the current versions to each application automatically.]]

[[R14 The system shall record an expiry date for each organisation document and shall ask the organisation to upload a new version when one expires.]]

[[R15 Accounts shall be treated as expired 18 months after the end of the financial year they cover.]]

### 5.3 Bank details

The audit found that bank details had been changed on the strength of an email. The new system must make that impossible.

[[R16 An organisation shall enter its bank details in the system, and the system shall verify that the account name matches the organisation's name using the council's bank account verification service before the details can be used for a payment.]]

[[R17 A change to an organisation's bank details shall only take effect after a grants officer has confirmed it by telephone with a person connected with the organisation, using a telephone number already held on the record, and the system shall record who made the call and when.]]

[[R18 No payment shall be released to bank details that were changed in the previous 10 working days until a finance officer has reviewed the change.]]

## 6. Eligibility and application

### 6.1 Eligibility check

The eligibility check tells applicants before they invest time in an application whether they can apply. It also reduces the number of ineligible applications officers have to reject.

[[R19 Before starting an application, an applicant shall answer the round's eligibility questions, and the system shall tell them immediately whether they are eligible, and if not, which answer made them ineligible.]]

[[R20 An applicant who is not eligible shall be shown the contact details of the grants team and of the local umbrella body that can offer advice.]]

[[R21 The system shall prevent an organisation from applying to a round if it has an overdue monitoring report on any previous grant.]]

[[R22 An organisation shall not hold more than one open application to the same round.]]

### 6.2 Completing an application

[[R23 The application form shall save the applicant's answers automatically as they are entered, and the applicant shall be able to leave and return to the application at any time before the round closes.]]

[[R24 Several users of the same organisation shall be able to work on an application, but only one shall be able to edit it at a time, and the system shall show who is editing.]]

[[R25 The application shall include a budget table in which the applicant lists each item of expenditure, its cost and whether it is capital or revenue, and the system shall calculate the total and check that it equals the amount requested.]]

[[R26 The system shall not allow an application to request less than the round's minimum or more than its maximum grant.]]

[[R27 Before submitting, the applicant shall confirm a declaration that the information given is true, and the system shall record the name of the person who confirmed it and the date and time.]]

[[R28 When an application is submitted the system shall send the applicant an acknowledgement by email with a reference number and the date by which a decision is expected.]]

### 6.3 Accessibility of the application process

The council's Equality and Inclusion officer asked that the application process not exclude people who find online forms difficult. The umbrella bodies support this, noting that some of the smallest groups have no regular access to a computer.

[[R29 A grants officer shall be able to complete and submit an application on behalf of an applicant who cannot apply online, recording that they did so and the applicant's confirmation of the declaration.]]

[[R30 The Youth Voice fund application form shall use plain language suitable for applicants aged 13 to 25, and shall allow a group of young people to apply with the support of a named adult.]]

The application process should be quick to complete for small grants.

## 7. Assessment

### 7.1 Allocating assessors

Each round's applications are scored by assessors against the round's criteria. For small grants one assessor is enough; larger grants are scored by two assessors independently and then moderated.

[[R31 A grants officer shall be able to allocate applications to assessors, and the system shall require two independent assessors for any application requesting more than 10,000.]]

[[R32 Before an assessor can see an application, they shall declare whether they have any interest in the applicant organisation, and an assessor who declares an interest shall not be able to see or score the application.]]

[[R33 The system shall record every declaration of interest, including declarations of no interest, with the date and the person who made it.]]

[[R34 External volunteer assessors shall only see the applications allocated to them and shall not see the organisation's bank details or the scores of other assessors.]]

### 7.2 Scoring and moderation

[[R35 An assessor shall score each criterion on a scale defined for the round and shall write a comment for each score, and the system shall calculate the weighted total.]]

[[R36 Where the weighted totals given by two assessors differ by more than 20% of the maximum score, the system shall flag the application for moderation.]]

[[R37 The moderated score and the reason for any change from the assessors' scores shall be recorded, and the assessors' original scores shall be kept.]]

[[R38 A grants officer shall carry out due diligence on every application recommended for funding before it goes to the decision-maker, recording the checks made and their outcome.]] Due diligence includes checking the organisation's accounts, its governing document and, for grants over 25,000, a credit check.

## 8. Decisions

### 8.1 Decision-making authority

Who can decide on a grant depends on the programme and the amount. The table below summarises the council's scheme of delegation for grants.

| Amount of grant | Decision-maker |
|---|---|
| Up to 5,000 | [[R39 A grants officer can decide on grants of up to 5,000 under delegated authority.]] |
| 5,001 to 25,000 | [[R40 The programme's grant panel decides on grants from 5,001 to 25,000.]] |
| 25,001 to 100,000 | [[R41 The Cabinet member for communities decides on grants from 25,001 to 100,000.]] |
| Over 100,000 | [[R42 Cabinet decides on grants over 100,000.]] |

[[R43 The system shall route each recommended application to the decision-maker required by the scheme of delegation, based on the total value of the grant over its whole term.]] For multi-year Strategic Partnerships grants, the total over all years determines the decision-maker.

[[R44 A grant panel member who has an interest in an application shall declare it before the panel meets, and the system shall exclude them from the decision on that application.]]

### 8.2 Recording decisions

[[R45 The system shall record each decision as approved, approved with conditions, or declined, with the decision-maker, the date, the amount approved and the reasons.]]

[[R46 The total approved in a round shall not exceed the round's budget, and the system shall show the decision-maker the remaining budget before each decision.]]

[[R47 Every applicant shall be told the decision on their application by email within five working days of the decision, and declined applicants shall be given the assessors' comments as feedback.]]

[[R48 Decisions on grants over 25,000 shall be published on the council's website, showing the organisation, the amount and the purpose.]]

### 8.3 Ward Member Grants

Ward Member Grants work differently from the other programmes. Each elected member has an annual allocation to spend in their ward. Members recommend grants and an officer checks them before they are paid.

[[R49 Each ward member shall be able to see their remaining allocation for the year and recommend a grant to an eligible organisation for a project in their ward.]]

[[R50 A ward member shall not be able to recommend a grant to an organisation in which they have declared an interest in the council's register of members' interests.]]

[[R51 A grants officer shall check every Ward Member Grant recommendation for eligibility and shall approve or reject it, and a rejected recommendation shall return the amount to the member's allocation.]]

[[R52 Ward Member Grants shall not be recommended in the six weeks before a local election.]]

## 9. Grant agreements

### 9.1 Issuing an agreement

The audit found grants paid before the agreement was signed. The system must prevent this.

[[R53 When a grant is approved, the system shall generate a grant agreement from the template for the programme, including the amount, the purpose, any conditions set by the decision-maker, the payment schedule and the monitoring requirements.]]

[[R54 The grant recipient shall sign the grant agreement electronically through the system, and the agreement shall be signed by two people connected with the organisation for grants over 5,000.]]

[[R55 No payment shall be made on a grant until the grant agreement has been signed by the recipient and countersigned by the council.]]

[[R56 An offer of a grant shall lapse if the agreement is not signed within a reasonable time, and the amount shall be returned to the round's budget.]]

### 9.2 Payment schedules

[[R57 Grants up to 10,000 shall be paid in a single payment after the agreement is signed, and grants over 10,000 shall be paid in instalments set out in the payment schedule.]]

[[R58 For Strategic Partnerships grants, instalments after the first shall only be released once the previous quarter's monitoring report has been accepted.]]

## 10. Payments

Payments are made by the Finance service through the finance system. The grants system prepares the payment and Finance checks and releases it.

[[R59 When a payment is due under the payment schedule and its conditions have been met, the system shall create a payment request containing the grant reference, the amount, the cost centre and the recipient's verified bank details.]]

[[R60 A finance officer shall review each payment request and release it to the finance system, and the system shall prevent the officer who approved the grant from releasing its payment.]]

[[R61 The system shall record the payment date and the finance system reference when Finance confirms that a payment has been made.]]

[[R62 The system shall stop a payment request automatically if the recipient organisation's charity or company registration shows it as removed, dissolved or in insolvency.]]

## 11. Variations

Funded projects change. A recipient may need more time, may want to spend money on a different item, or may need to reduce the scale of the project.

[[R63 A recipient shall be able to request a variation to their grant through the system, explaining what they want to change and why.]]

[[R64 A variation that changes the amount of the grant shall be decided by the decision-maker who would be required for the new total amount.]]

[[R65 A variation that moves less than 10% of the grant between budget items, without changing the total, shall be decided by a grants officer.]]

[[R66 Every variation shall be recorded against the grant agreement, and the system shall keep the agreement as originally signed as well as the agreement as varied.]]

## 12. Monitoring and closure

### 12.1 Monitoring reports

Monitoring tells the council whether its money is achieving what was intended. The requirements are set in proportion to the size of the grant.

| Grant size | Monitoring required |
|---|---|
| Up to 5,000 | [[R67 Recipients of grants up to 5,000 submit a single end-of-grant report.]] |
| 5,001 to 25,000 | [[R68 Recipients of grants from 5,001 to 25,000 submit a mid-point report and an end-of-grant report.]] |
| Over 25,000 | [[R69 Recipients of grants over 25,000 submit quarterly reports and an end-of-grant report with evidence of expenditure.]] |

[[R70 The system shall remind the recipient of each monitoring report 14 days before it is due and again on the due date, and shall mark the report as overdue if it is not submitted within 14 days after the due date.]]

[[R71 A grants officer shall review each monitoring report and record whether it is accepted, and may ask the recipient for more information.]]

[[R72 Monitoring reports shall collect the outcome measures set for the round, so that the council can report the outcomes achieved across all grants in a programme.]]

### 12.2 Clawback and closure

[[R73 Where a grant has not been used for its agreed purpose, a grants officer shall be able to start a clawback, recording the amount to be recovered and the reason, and the system shall send a request for repayment to the recipient.]]

[[R74 A clawback over 5,000 shall be approved by the programme manager before the request for repayment is sent.]]

[[R75 A grant shall be closed when the end-of-grant report has been accepted and every payment and any clawback has been completed.]]

## 13. Reporting

Officers, members and auditors all need information from the system. Today producing even a simple report takes days.

[[R76 The system shall report, for any period, the grants awarded and paid by programme, round, ward and organisation.]]

[[R77 The system shall show, for any organisation, every application it has made and every grant it has received from the council across all programmes.]]

[[R78 The system shall report the applications received, approved and declined in each round, with the reasons for declining, by ward and by the equality information applicants provided.]]

[[R79 Each ward member shall be able to see the grants awarded in their ward under all programmes.]]

[[R80 Auditors shall be able to see every record in the system, including declarations of interest, decisions, bank detail changes and their verification, without being able to change anything.]]

## 14. Non-functional requirements

### 14.1 Accessibility and usability

[[R81 The applicant-facing parts of the system shall meet the WCAG 2.2 AA standard and shall work on mobile phones as well as on computers.]]

[[R82 The application process for a grant under 1,000 shall be completable in no more than 30 minutes by a first-time applicant who has their organisation documents to hand.]]

### 14.2 Availability and performance

[[R83 The system shall be available at least 99.5% of the time, and in the last 48 hours before a round closes it shall have no planned maintenance.]]

[[R84 The system shall support at least 500 applicants working on applications at the same time without a page taking more than three seconds to load.]]

### 14.3 Security and data protection

[[R85 Council users shall sign in with the council's single sign-on, and applicants and external assessors shall sign in with an email address, a password and a second factor.]]

[[R86 Personal data about applicants' service users, if any is included in an application by mistake, shall be removable by a grants officer without deleting the rest of the application.]]

[[R87 The system shall retain records of approved grants for seven years after the grant is closed and records of declined applications for two years after the decision, and shall then delete them.]]

[[R88 Equality information given by applicants shall be optional, shall be kept separately from the application, and shall not be visible to assessors or decision-makers.]]

### 14.4 Audit

[[R89 Every action that changes a record in the system shall be recorded with the user, the date and time, and the value before and after the change, and the audit record shall not be editable or deletable by any user.]]

## 15. Data migration

The council holds records of grants made in the last six years in spreadsheets and on the shared drive. Some are incomplete, and the same organisation often appears under several names.

[[R90 Grants made in the three financial years before go-live shall be migrated into the system with their organisation, amount, programme and status, so that reports of funding to an organisation are complete.]]

[[R91 Before migration, organisation records that appear to refer to the same organisation shall be presented to a grants officer for a decision on whether to merge them.]]

[[R92 Strategic Partnerships grants that are in progress at go-live shall be migrated with their agreements, payment schedules and monitoring reports, so that they can be managed in the system from go-live.]]

## 16. Assumptions and open questions

### 16.1 Assumptions

- The council's bank account verification service can be called by the system for each new or changed set of bank details.
- The finance system can accept payment requests from the grants system through its existing interface.
- The public register of charities and the register of companies can be queried by number.
- The council's single sign-on can be used by the system for staff and members.

### 16.2 Open questions

- [[A1 Legal Services have been asked to advise how long a grant offer may stay open before it lapses.]]
- [[A2 Programme managers have suggested that small organisations with an annual income below a threshold should not have to provide accounts, but the threshold has not been set.]]
- The Youth Voice fund panel includes young people who are under 18. Legal Services are considering whether they can take part in decisions recorded in the system or whether an adult must record the decision for them.
- [[A3 Some ward members have asked to be told when an organisation in their ward applies to any programme; no decision has been made.]]

## Appendix A. Programme-specific rules

The general requirements in sections 4 to 12 apply to every programme. Each programme also has rules of its own, set by the programme's terms and summarised here. The system must allow these rules to be applied for the programme concerned without affecting other programmes.

### A.1 Neighbourhood Fund

The Neighbourhood Fund supports projects that improve life in a defined neighbourhood. Applicants describe the neighbourhood their project serves, and the fund's panel gives priority to the twelve neighbourhoods identified in the council's deprivation index as being in the most deprived fifth nationally. The fund opens two rounds a year, in spring and autumn, each with half of the annual budget.

[[R93 A Neighbourhood Fund application shall record the neighbourhood the project serves, chosen from the council's list of neighbourhoods, and the system shall add the priority weighting set for the round to the weighted score of applications from priority neighbourhoods.]]

[[R94 An organisation shall not receive more than one Neighbourhood Fund grant in the same financial year.]]

### A.2 Strategic Partnerships

Strategic Partnerships grants fund services that the council would otherwise commission, such as advice services, carers' support and community transport. Grants last up to three years, with each year's funding confirmed in the council's budget. Partners meet their relationship manager each quarter.

[[R95 A Strategic Partnerships grant agreement shall state that the second and third years' funding is subject to the council's annual budget, and the system shall require the programme manager to confirm each year's funding before its first instalment is released.]]

[[R96 Each Strategic Partnerships grant shall have a named relationship manager, and the system shall record a note of each quarterly meeting against the grant.]]

### A.3 Small Sparks

Small Sparks gives quick, simple grants to new and very small groups. The fund is open all year, and decisions are made within ten working days. The application form is much shorter than for other programmes and asks only about the activity, the cost and who will benefit.

[[A14 Small Sparks grants range from 100 to 1,500, and groups without a bank account in their own name may be paid through a sponsoring organisation.]]

[[R97 Where a Small Sparks grant is paid through a sponsoring organisation, the system shall record the sponsor, verify the sponsor's bank details in the same way as a recipient's, and require the sponsor to sign the grant agreement as well as the group.]]

[[R98 A decision on a Small Sparks application shall be made within ten working days of submission, and the system shall alert the programme manager about any application still undecided after eight working days.]]

### A.4 Youth Voice

The Youth Voice fund is run jointly with the youth council. Applications are assessed by a panel of young people supported by youth workers.

[[R99 Assessors for the Youth Voice fund may be members of the youth council aged 16 or over, and the system shall record that an assessor is a youth panel member and the name of the supporting youth worker.]]

### A.5 Arts in the Open

Arts in the Open funds outdoor arts events that are free to attend. Events take place in parks, squares and streets and often need permissions from other council services.

[[R100 An Arts in the Open grant shall not be paid until the applicant has uploaded the event permission from the council's events team, and the system shall record the permission reference.]]

[[R101 If an Arts in the Open event is cancelled because of bad weather, the recipient may keep costs already incurred, and the system shall allow a grants officer to record a partial clawback of the remainder.]]

### A.6 Winter Warmth

The Winter Warmth fund supports warm spaces and practical help for residents during the winter months. Grants must be spent between November and March.

[[R102 Winter Warmth grants shall only be approved for activities that take place between 1 November and 31 March, and the end-of-grant report shall be due by 30 April.]]

## Appendix B. Worked examples

The following examples were used in the workshops to check that the requirements describe the process the council intends. They are illustrations only and do not add requirements.

A community garden group applies to the Neighbourhood Fund for 8,500 to build raised beds and run gardening sessions for older residents in a priority neighbourhood. The group registers its organisation, uploads its constitution, last year's accounts and its policies, and completes the eligibility check. Its application is scored by two assessors because the amount is over 5,000 but under 10,000 only one would be needed; the grants officer allocates two anyway because the group is new. The scores differ by 25% of the maximum, so the application is moderated. After due diligence, the application goes to the Neighbourhood Fund panel, which approves it with a condition that the group obtains the landowner's written consent. The group signs the agreement with two of its committee members, and the grant is paid in one payment because it is under 10,000. The group submits a mid-point report and an end-of-grant report.

An advice charity holds a three-year Strategic Partnerships grant of 90,000 a year. Because the total over three years is 270,000, the decision was made by Cabinet. The charity's grant is paid in quarterly instalments, each released after the previous quarter's monitoring report is accepted. In the second year the charity asks to move 6,000 from staff costs to rent because it is moving office. Because this is less than 10% of the year's grant and does not change the total, the grants officer decides the variation.

A ward member wishes to give 750 to a residents' association for a summer street party. The member checks their remaining allocation, confirms that they have no interest in the association, and makes the recommendation. A grants officer checks that the association is registered and eligible and approves the recommendation, and the grant is paid in a single payment. The association submits a short end-of-grant report with photographs.

A youth group applies to the Youth Voice fund for 2,000 for a film project. The application is made by four young people with a youth worker named as the supporting adult. The youth panel assesses it, and a youth worker records the decision.

<!-- labels
A1 [tbd] @R56: a grant offer lapses after "a reasonable time", and Legal Services have not yet advised on the period => How long may a grant offer remain unsigned before it lapses and the money returns to the round budget?
A2 [tbd] @R13,R38: an income threshold below which accounts are not required has been suggested but not set, and R13 and R38 assume accounts always exist => Is there an income threshold below which an organisation need not provide accounts, and what is it?
A3 [tbd] @R79: whether ward members are notified of applications from their ward is undecided, and R79 shows them only awarded grants => Should ward members be told when an organisation in their ward applies, and at what stage?
A4 [conflict] @R39,R40: the decision table bands are "up to 5,000" and "5,001 to 25,000", but monitoring and signature rules use "over 5,000", so a grant of 5,000.50 or a multi-year total near a boundary is unclear => How are amounts between band boundaries, such as 5,000.50, treated for decision-making?
A5 [conflict] @R43,R40: decision-making uses the whole-term total for multi-year grants, but the document does not say whether the monitoring and payment tables use the annual or the total amount => For multi-year grants, do the monitoring, signature and instalment rules use the annual amount or the total over the term?
A6 [vague-term] @R82: "the application process should be quick to complete for small grants" adds nothing measurable beyond the 30-minute target, and "small" is undefined => Which grants count as small for the quicker application process: under 1,000, Small Sparks only, or something else?
A7 [missing] @R6,R7: an extension can be granted to a single applicant, but nothing says how long it may be or whether it is allowed after assessment has begun => What is the longest extension the programme manager may grant, and may it be granted once the round has closed?
A8 [conflict] @R57,R58: grants over 10,000 are paid in instalments, while Strategic Partnerships instalments depend on quarterly monitoring; for a 12,000 Neighbourhood grant, the monitoring rules require only a mid-point report, so the release condition for later instalments is unstated => What condition releases the second and later instalments of a non-Strategic grant over 10,000?
A9 [missing] @R21,R70: an overdue report blocks new applications, but the document does not say whether a report submitted late but not yet accepted still blocks => Does an organisation remain blocked from applying while a late monitoring report awaits review?
A10 [conflict] @R31,R39: two assessors are needed above 10,000, and a grants officer can decide alone up to 5,000; the document does not say whether the officer who decides may also be the assessor => May a grants officer assess an application and then decide it under delegated authority?
A11 [missing] @R30,R45: young people under 18 sit on the Youth Voice panel, and Legal Services have not decided whether they can record decisions in the system => Can panel members under 18 record decisions in the system, or must an adult record the decision for them?
A12 [vague-term] @R12: a grants officer adds a user "after verifying the person's connection with the organisation", with no stated evidence required => What evidence must a grants officer see before adding a user to an organisation that has no other active users?
A13 [missing] @R52,R49: the six weeks before a local election block recommendations, but nothing says what happens to recommendations already made and not yet approved in that period => Can a Ward Member Grant recommended before the pre-election period be approved and paid during it?
A14 [conflict] @R97,R16: Appendix A gives Small Sparks grants of 100 to 1,500, while section 1.1 says Small Sparks is for grants up to 1,000; and paying through a sponsor sits awkwardly with R16's check that the account name matches the organisation => Is the Small Sparks maximum 1,000 or 1,500, and whose name must a sponsored group's bank account match?
-->
