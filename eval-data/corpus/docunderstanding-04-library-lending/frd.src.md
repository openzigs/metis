# Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

## About this document

This functional requirements document describes the platform Kestrel Vale Council needs to run membership and lending across its public library service. It covers everything from a resident joining the library to the return of the last item they borrowed, including reservations, renewals, the home library service, the mobile libraries, e-lending and the public computers in each branch. It will be used by the procurement team to evaluate the suppliers who respond to the tender, by the chosen supplier to configure the platform, and by the Libraries service to plan acceptance testing and staff training.

The document was written by the council's Digital Services business analysts with the Libraries management team, branch staff from six of the fourteen branches, the home library service coordinator, the Finance service, the Information Governance team, the council's accessibility lead and members of the Friends of Kestrel Vale Libraries, a volunteer group who ran a series of listening sessions with library users over the summer. It reflects the library strategy adopted by the council's Cabinet and the lending policy approved by the Libraries Board in the spring.

Readers new to public libraries should start with sections 1 to 3. Sections 4 to 16 describe what the platform must do, grouped by what a member or a member of staff is trying to achieve. Section 17 covers staff administration, section 18 the reports, sections 19 to 21 data protection, accessibility and the non-functional requirements, section 22 the migration from the current system and section 23 the assumptions and open issues. The appendices summarise entitlements and the notification schedule for quick reference.

### How the requirements are written

The Libraries service asked that the parts of this document that describe what a member experiences be written to the member, in the same voice the library uses in its leaflets and on its website, so that the Friends group and the members who took part in the listening sessions could check them. Those requirements are therefore written as "you", meaning the member. Requirements about what staff do are written either to the member of staff or about them. Some requirements are written as statements of what happens, for example that overdue notices are sent by email. Others use the more traditional "the platform shall".

All of these are requirements, whichever way they are phrased. A statement that something will happen, that you can do something, that you must do something or that something is done is as binding on the supplier as a statement that uses "shall". Background, explanation and examples are not requirements, and they are written as ordinary prose.

## 1. Introduction

### 1.1 The library service

Kestrel Vale Libraries is the public library service of Kestrel Vale Council. It runs fourteen branch libraries, two mobile libraries that visit around ninety villages and estates on a fortnightly timetable, a home library service that delivers books to residents who cannot get to a library, and a local studies centre attached to the central library. The service has around 61,000 active members, holds around 420,000 physical items and lends around 1.3 million items a year, about a fifth of which are e-books and e-audiobooks.

The branches vary a great deal. The central library is open seven days a week and has a staffed enquiry desk, four self-service kiosks, sixty public computers and a children's library. Five of the smaller branches are open three days a week and are staffed by one person at a time. Four branches run extended hours using an open-access system, which lets members with an extended-hours enrolment enter the building with their card and PIN when no staff are present. The two mobile libraries have no permanent connection to the council's network and work offline for most of the day.

The service is free to join. Members can borrow books, audiobooks, music scores, DVDs and a small collection of equipment such as reading lamps and energy monitors. Children's and teenage books have never carried overdue charges. Adult overdue charges are being withdrawn, as described in section 11.

### 1.2 Why a new platform is needed

The service uses a library management system that the council has run for fourteen years. The supplier will stop supporting it at the end of next year. The system runs on servers in the council's own data centre, which is itself due to close. It has no public interface of its own: members use a separate online catalogue, a separate e-lending app and a separate payments page, each with its own sign-in.

Staff report that the current system makes simple tasks slow. Registering a new member at the counter takes eleven screens. Merging two duplicate records cannot be done at all, so duplicates are left in place and members sometimes receive two sets of notices. Reservations placed at a branch that is closing for refurbishment have to be moved by hand. The reports that the Libraries Board receives each quarter are assembled in a spreadsheet from four separate extracts.

Members have their own concerns. In the listening sessions, members said that it is hard to find out what they have on loan and when it is due, that the renewal page often fails, that they are not told when an item they reserved has been waiting for them for several days, and that the joining form asks for information they do not understand the need for. Parents said they cannot see their children's loans from their own account. Members who are blind or partially sighted said the online catalogue cannot be used with a screen reader.

### 1.3 Objectives

The objectives agreed by the project board are:

- Replace the current library management system before support ends, with no loss of member or loan records.
- Give members a single account, reached from one sign-in, for everything they borrow, reserve and pay for.
- Make joining quick, and make it possible entirely online for residents who can prove who they are online.
- Support the withdrawal of adult overdue charges agreed by Cabinet.
- Make the service usable by members who rely on assistive technology.
- Reduce the time staff spend on routine administration, so they can spend more time helping members.
- Give the Libraries Board accurate, timely information about membership and use by branch and by area.

### 1.4 Constraints

The platform must be bought as a hosted service. The council will not run servers for it. The council's customer identity service, which residents already use for council tax and waste services, is the preferred sign-in for members but is not mandatory: many members, especially children and older residents, do not have an account with it. The council's payment gateway must be used for every card payment taken online or at a kiosk. The e-lending catalogue and loans are provided by the council's e-lending supplier under a separate contract; the platform must work with that supplier's lending service but will not replace it.

## 2. Scope

### 2.1 In scope

The platform will support membership, lending, renewals, reservations, returns, charges and payments, the home library service, the mobile libraries, the extended-hours enrolment, public computer bookings, member communications and the reports the service needs. It will be used by members, by parents and carers on behalf of children, by branch staff, by the home library service coordinator and volunteers, by the mobile library crews, by stock and systems staff at the central library, by Finance and by the Information Governance team.

### 2.2 Out of scope

The following are out of scope: the acquisition and cataloguing of stock, which remains in the council's stock acquisition system and is fed to the platform as catalogue records; the local studies centre's archive catalogue; events and room bookings, which use the council's venue booking system; the door-control hardware for extended-hours branches, which is provided by the building management contract; and the public Wi-Fi, which is provided by the council's network contract. The platform will exchange information with each of these where this document says so, but it will not replace them.

### 2.3 Users

- Members: anyone who holds a library card, including children.
- Parents and carers: adults who act for a child member, and who may hold a membership of their own.
- Branch staff: library assistants and branch supervisors, who serve members at the counter and manage the branch.
- Home library service coordinator: the member of staff who arranges deliveries to housebound members.
- Home library volunteers: volunteers who select and deliver items to housebound members.
- Mobile library crews: drivers and library assistants who run the two mobile libraries.
- Stock and systems staff: staff at the central library who manage the catalogue feed, the stock rotation and the platform's configuration.
- Finance officers: staff in the Finance service who reconcile payments and refunds.
- Information Governance officers: staff who handle subject access requests and data retention.
- Libraries Board: the senior managers who set lending policy and receive the service's reports.

## 3. Glossary

- Member: a person who holds a Kestrel Vale Libraries card.
- Card: the physical or digital card that identifies a member, carrying a fourteen-digit card number.
- Borrower category: the class of membership that sets a member's entitlements, such as Adult, Junior or Teen.
- Entitlement: what a borrower category allows, such as the number of items a member may have on loan and the loan period.
- Loan: an item recorded as borrowed by a member, with a due date.
- Renewal: an extension of a loan's due date without the item being returned.
- Reservation: a request by a member for a particular title, or a particular copy, to be held for them when it becomes available. Also called a hold.
- Pickup location: the branch or mobile library stop where a member chooses to collect a reservation.
- Hold shelf: the shelf in a branch where reserved items wait to be collected.
- Kiosk: a self-service terminal in a branch on which members borrow, return and renew items and pay charges.
- Block: a restriction on a member's account that prevents some or all borrowing until it is cleared.
- Replacement charge: the amount a member is asked to pay for an item that is lost or damaged beyond use.
- Home library service: the service that delivers items to members who cannot visit a library because of age, illness, disability or caring responsibilities.
- Extended-hours enrolment: the permission a member needs to enter an extended-hours branch when no staff are present.
- E-loan: a loan of an e-book or e-audiobook made through the e-lending supplier's service.
- Inter-library request: a request for an item that Kestrel Vale Libraries does not hold, supplied by another library service.
- Responsible adult: the parent, carer or guardian linked to a child member's account.

## 4. Joining the library

### 4.1 Who can join

The library is open to everyone, but membership, which lets a person borrow, is offered to people with a connection to Kestrel Vale. The lending policy sets that connection deliberately wide, because many people who use the central library live in the neighbouring districts and work in the town centre.

[[R1 You can join the library if you live, work or study in Kestrel Vale, whatever your age.]]

[[R2 Proof of address is not required for a child who joins with a responsible adult who is already a member.]]

### 4.2 Joining online

About a third of new members join online today, using a form that creates a record staff must then complete at the counter. The listening sessions found that many people abandon the form when it asks for information without saying why. Joining online should be complete in itself for anyone who can prove who they are online.

[[R3 You must be able to join online by giving your name, date of birth, home address and at least one way for the library to contact you, which is either an email address or a mobile phone number.]]

[[R4 The platform shall check the address you give against the council's address gazetteer and, if the address is outside Kestrel Vale, shall ask whether you work or study in Kestrel Vale before you can continue.]]

[[R5 If you sign in with the council's customer identity service, your name, date of birth and verified address will be filled in for you, and you will not be asked to prove them again.]]

[[R6 If you join online without the customer identity service, you will receive a digital card straight away that lets you borrow e-books and e-audiobooks and reserve items, and you will be able to borrow physical items once a member of staff has seen your proof of identity and address.]]

[[R7 The platform shall show, next to each question on the joining form, why the library needs the information and whether the question is optional.]]

[[R8 Equality monitoring questions, such as ethnicity and disability, are asked only after a person has joined, and answering them is always optional.]]

[[R9 You will receive a welcome email or text message with your card number within five minutes of joining online.]]

[[R10 Before a new membership is created, the platform shall look for existing members with the same name and date of birth, or with the same email address, and shall warn the person joining, and the member of staff if there is one, that a duplicate may exist.]]

### 4.3 Joining in a branch

Most members still join in a branch, often with a child. The current registration screens are the most common complaint from branch staff.

[[R11 As a member of branch staff, you must be able to register a new member at the counter on a single screen, scanning a new card and recording the proof of identity and address you have seen in the same visit.]]

[[R12 You must be able to print, or show on screen, a summary of the information recorded about a new member before they leave the counter.]]

[[R13 New members who join in a branch are given a physical card at the counter, and the card is activated as soon as it is scanned against the new record.]]

### 4.4 Proof of identity and address

Physical items are valuable and the library must be able to contact a member who does not return them. The lending policy therefore asks adults who want to borrow physical items to prove who they are and where they live. The evidence accepted is set out below.

| Evidence | Accepted as proof of |
|---|---|
| Photocard driving licence | [[R14 A photocard driving licence is accepted as proof of both identity and address.]] |
| Passport or national identity card | [[R15 A passport or national identity card is accepted as proof of identity only.]] |
| Utility bill, bank statement or council tax bill | [[R16 A utility bill, bank statement or council tax bill dated within the last three months is accepted as proof of address only.]] |
| Letter from a trusted referee | [[R17 A letter from a trusted referee is accepted as proof of both identity and address for a resident who has none of the other evidence.]] |
| Student card | [[R18 A student card from a school or college in Kestrel Vale is accepted as proof of identity for members aged 16 to 18.]] |

[[R19 The platform shall record which kind of evidence was seen and by whom, but shall not store a copy of any document or any document's number.]]

[[R20 A person who cannot provide any of the evidence in the table may be given a Restricted membership by a branch supervisor.]] Restricted membership exists for people who are homeless, newly arrived or living in temporary accommodation. The lending policy is clear that nobody should be refused a library card because they lack a fixed address.

### 4.5 Children and young people

Children have always been able to join the library from birth. Branch staff estimate that a quarter of new members are under five, joined by a parent at a rhyme time session.

[[R21 A child under 16 can only join with the consent of a responsible adult, who is linked to the child's account when the child joins.]]

[[R22 Up to two responsible adults shall be linkable to a child's account.]]

[[R23 As a responsible adult, you will be able to see your linked children's loans, reservations and due dates from your own account, and to renew their items.]]

[[R24 A child's account is moved to the Teen category automatically on the child's 12th birthday and to the Adult category on their 18th birthday, and the member and any responsible adult are told about the change a week before it happens.]]

[[R25 The platform shall stop showing a child's loans to a responsible adult when the child turns 16, unless the child agrees to keep sharing them.]]

### 4.6 Visitor membership

Students on short placements, seasonal workers and visitors staying with family sometimes want to borrow while they are in the area.

[[R26 If you are visiting Kestrel Vale, you can take out a Visitor membership that lasts three months and can be renewed once.]]

[[R27 Visitor members have the entitlements set out in section 6 for their borrower category.]]

[[R28 A Visitor membership shall expire automatically at the end of its term, and its holder shall be asked to return any items still on loan.]]

## 5. Cards, sign-in and your account

### 5.1 Cards

The service issued around 7,500 replacement cards last year, most of them to members who had lost a card or left it at home. Members in the listening sessions asked for a card they could keep on their phone.

[[R29 You can use either a physical card or a digital card shown on your phone; both carry the same card number and both work at the counter, on kiosks and at extended-hours doors.]]

[[R30 You will be able to add your digital card to your phone's wallet app.]]

[[R31 A replacement physical card is issued at the counter free of charge the first time in any twelve months; any further replacement in the same twelve months costs 2.50.]]

[[R32 When a replacement card is issued, the platform shall cancel the old card number immediately so that it can no longer be used to borrow or to enter an extended-hours branch.]]

### 5.2 PINs and signing in

[[R33 You will sign in to your account online with either the customer identity service or your card number and PIN.]]

[[R34 PINs shall be at least six digits, and the platform shall refuse a PIN that repeats one digit or is a simple sequence.]]

[[R35 You must be able to reset your PIN yourself, using a link sent to your email address or a code sent to your mobile phone.]]

[[R36 After five failed attempts to sign in with a card number and PIN, the platform shall lock the PIN for 30 minutes and tell the member by their preferred contact method.]]

[[R37 Members borrowing at a kiosk are identified by scanning their card or by typing their card number.]] [[A1 Whether a PIN should also be required to borrow at a kiosk, or whether the card alone should be enough, has not yet been decided by the Libraries Board.]] Branch staff are divided: a PIN protects members whose card is lost, but many older members do not remember theirs.

### 5.3 Your account

[[R38 You must be able to see, on one page, everything you have on loan with its due date, everything you have reserved with its place in the queue, any charges you owe and any blocks on your account.]]

[[R39 You will be able to see a list of the items you have borrowed in the past, if you have chosen to keep a borrowing history.]]

[[R40 A borrowing history is kept only for members who choose to keep one, and the choice is off by default.]]

[[R41 You can change your contact details, your preferred pickup location and your notification preferences at any time.]]

[[R42 You will be asked to confirm a new email address or mobile number from that address or number before it is used.]]

[[R43 The platform shall record every change made to a member's details, who made it and when, and shall show this history to branch staff.]]

### 5.4 Keeping your membership

Membership does not need to be renewed by an active member. The Libraries Board wants inactive records to be closed, both to keep the membership figures honest and because the council should not keep personal information it no longer needs.

[[R44 An adult membership is extended automatically each time the member borrows, renews or reserves an item.]]

[[R45 The platform shall mark a membership as inactive when the member has not borrowed, renewed, reserved or signed in for three years, and shall delete the record six months later if the member has not responded to a reminder.]]

[[R46 You will be reminded by your preferred contact method one month before your membership is closed for inactivity.]]

### 5.5 Closing an account and merging duplicates

[[R47 You can ask to close your membership at any time, online or in a branch, as long as you have nothing on loan and owe no replacement charges.]]

[[R48 As a branch supervisor, you must be able to merge two records that belong to the same person, keeping the loans, reservations, charges and history of both under the card number the member chooses.]]

[[R49 Possible duplicate records found by the platform shall be listed for branch supervisors to review, and duplicates are to be resolved quickly once they have been identified.]]

## 6. Borrower categories and entitlements

Every member belongs to one borrower category, which sets how many items they may have on loan, how many reservations they may have open and what they may borrow. The categories below are those in the lending policy approved by the Libraries Board in the spring. Appendix A summarises them in a table for quick reference.

The borrower categories are:

1. Adult, for members aged 18 and over.
- [[R50 Adult members may have up to 20 items on loan at once, of which no more than four may be DVDs.]]
- [[R51 Adult members may have up to 15 reservations open at once.]]
2. Teen, for members aged 12 to 17.
- [[R52 Teen members may have up to 12 items on loan and 8 reservations open at once.]]
- [[R53 Teen members cannot borrow a DVD with an 18 certificate.]]
3. Junior, for members under 12.
- [[R54 Junior members may have up to 12 items on loan and 5 reservations open at once, and may borrow only from the children's and teenage collections and DVDs with a U or PG certificate, unless a responsible adult has agreed otherwise.]]
4. Restricted, for members who could not provide proof of identity and address.
- [[R55 Restricted members may have up to 3 items on loan at once and cannot borrow DVDs or equipment, but they have the same access to e-lending and to the public computers as Adult members.]]
5. Home library service, for members who receive deliveries.
- [[R56 Home library service members may have up to 30 items on loan, and each of their loans lasts until the next delivery rather than for a fixed period.]]
6. Institutional, for care homes, schools and nurseries.
- [[R57 Institutional members may have up to 60 items on loan for a loan period of eight weeks, and the platform shall record the named member of staff responsible for each institutional card.]]

[[R58 The platform shall hold the entitlements of each borrower category as configuration that stock and systems staff can change without the supplier's help, and every change shall be recorded with who made it and when.]]

[[R59 When a category's entitlements change, existing loans keep the due dates they already have.]]

## 7. Finding items in the catalogue

The current online catalogue is a separate product with its own sign-in. Members in the listening sessions described it as dated and hard to use on a phone, and said it does not show the e-books at all.

[[R60 You must be able to search the catalogue by title, author, subject, series, ISBN and keyword, and to filter the results by format, branch, age group, language and whether a copy is on the shelf now.]]

[[R61 You will see, for each title, how many copies the library has, which branches hold them, how many are on the shelf and how many reservations are waiting.]]

[[R62 The platform shall load the catalogue records sent by the council's stock acquisition system each night, and shall report any record it could not load to stock and systems staff the next morning.]]

[[R63 E-books and e-audiobooks from the e-lending supplier shall appear in the same search results as physical items, marked as such, and their availability shall be fetched from the supplier's service at the time of the search.]]

[[R64 You can save a search and choose to be told when a new title matches it.]]

[[R65 You can make lists of titles, and keep each list private or share it with anyone who has the link.]]

[[R66 Items that are for reference only, such as most of the local studies collection, are shown in search results but cannot be reserved or borrowed.]]

## 8. Borrowing

### 8.1 Self-service kiosks

Around 70 per cent of physical loans are made on kiosks. [[R215 The kiosks are owned by the council and will be kept; the platform must drive them through the standard self-service protocol that the current kiosks already use.]]

[[R67 You can borrow, return and renew items at any kiosk in any branch, and you will be given a receipt, printed or emailed as you choose, listing your due dates.]]

[[R68 A kiosk shall refuse a loan that would take the member over their entitlement, or that the member's category does not allow, and shall tell the member why in plain language.]]

[[R69 Kiosks shall be easy to use for older members and for members who have never used one before.]]

[[R70 Kiosks shall accept contactless card payments where the branch's equipment allows.]]

[[R71 If a kiosk loses its connection to the platform, it shall continue to lend and return items offline for up to four hours, and shall send the transactions to the platform when the connection returns.]]

### 8.2 Borrowing at the counter

Staff lend at the counter to members who prefer it, to members borrowing items that kiosks cannot handle, such as equipment and large sets of play scripts, and when kiosks are out of service.

[[R72 At the counter, you must be able to lend items to a member by scanning their card and the items, and to override an entitlement limit, recording your reason.]]

[[R73 Overrides of entitlement limits are reported to the branch supervisor each week.]]

[[R74 You must be able to lend items to a member who has forgotten their card, once you have confirmed who they are by asking for their date of birth and address.]]

### 8.3 Loan periods

The loan period depends on the kind of item. The periods below are those in the lending policy.

| Item type | Loan period | Rule |
|---|---|---|
| Books, audiobooks and music scores | Three weeks | [[R75 Books, audiobooks and music scores are lent for three weeks and can be renewed up to five times.]] |
| High-demand titles | One week | [[R76 High-demand titles are lent for one week and cannot be renewed.]] |
| DVDs | One week | [[R77 DVDs are lent for one week and can be renewed twice.]] |
| Equipment | Two weeks | [[R78 Equipment is lent for two weeks, cannot be renewed, and must be returned to the branch it was borrowed from.]] |

[[R79 The platform shall set due dates so that no item falls due on a day when the branch it was borrowed from is closed; such a due date moves to that branch's next opening day.]]

### 8.4 Equipment and age-rated items

[[R80 Equipment can be borrowed only by Adult members who have held their membership for at least three months.]]

[[R81 Before lending equipment, you must ask the member to confirm that they have read the safety guidance for it, and the platform shall record their confirmation.]]

[[R82 The platform shall prevent the loan of an item with an age certificate above the member's age, unless a responsible adult has given permission on the child's account.]]

## 9. Renewals

Renewals are the single most common reason members contact the library. The current renewal page fails for about one in twenty attempts, usually when a member has several items and one of them cannot be renewed; when that happens, none of the items is renewed.

[[R83 You can renew an item up to three times, online, by phone, at a kiosk or at the counter, as long as nobody else has reserved it.]]

[[R84 Each renewal runs for the item's normal loan period from the day of the renewal, not from the old due date.]]

[[R85 The platform shall renew every eligible item on a member's account automatically two days before it is due, and shall tell the member which items were renewed, which were not, and why not.]]

[[R86 When you renew several items at once, the items that can be renewed will be renewed even if some of the others cannot.]]

[[R87 Renewals by telephone are handled by an automated line that recognises the card number and PIN entered on the phone's keypad.]]

[[R88 You will still be able to renew items while your account is blocked, unless the block is for an item that is more than 28 days overdue.]]

## 10. Reservations

Members placed around 190,000 reservations last year. About 60 per cent were for items on the shelf at another branch; the rest were for items on loan. Reservations are popular with members but expensive for the service, because each one means an item travelling on the van between branches.

### 10.1 Placing a reservation

[[R89 You can reserve any title that can be borrowed, whether or not a copy is on the shelf, and choose any branch or mobile library stop as your pickup location.]]

[[R90 Reservations are free of charge for every member.]]

[[R91 The platform shall not let a member reserve a title they already have on loan, or reserve the same title twice.]]

[[R92 You can suspend a reservation for up to 90 days, for example while you are on holiday, without losing your place in the queue.]]

### 10.2 The queue and which copy is used

[[R93 Reservations for a title shall be filled in the order in which they were placed, except that reservations placed by priority members shall go ahead of other reservations.]]

[[R94 When a copy is returned at any branch, the platform shall check it against the queue of reservations and shall tell the member of staff or the kiosk whether the copy should go to the hold shelf or be sent to another branch.]]

[[R95 The platform shall prefer a copy at, or nearest to, the member's pickup location when choosing which copy fills a reservation.]]

### 10.3 Collecting a reservation

Members told the listening sessions that they often do not know an item is waiting for them until they happen to visit, and by then it may have gone back to the shelves.

[[R96 You will be told promptly when an item you reserved is ready to collect, by your preferred contact method.]]

[[R97 Reserved items are kept on the hold shelf for seven days, after which the reservation is cancelled and the item passes to the next member in the queue.]]

[[R98 You will receive a reminder two days before a reserved item you have not collected is taken off the hold shelf.]]

[[R99 You must be able to print a list each morning of the reservations that have expired on your branch's hold shelf, so that you can clear them.]]

[[R100 Members with an extended-hours enrolment can collect their reservations from the hold shelf during extended hours and borrow them on a kiosk.]]

### 10.4 Moving items between branches

A van visits every branch on weekdays and runs between the central library and the mobile library depot. Items travel in crates labelled by destination.

[[R101 An item needed to fill a reservation at another branch shall be sent on the next van run and shall arrive within three working days, unless this is operationally impractical.]]

[[R102 The platform shall show every item in transit, the branch it left and the branch it is going to, and shall flag any item that has been in transit for more than ten days.]]

[[R103 When a branch is to close temporarily, as a branch supervisor you must be able to move all of its reservations to another pickup location in one action, giving the members affected the standard notice period.]]

### 10.5 Requests from other library services

[[R104 If the library does not hold a title, you can ask for it to be borrowed from another library service, and you will be told within five working days whether the request has been accepted.]]

[[R105 Inter-library requests are limited to two at a time for each Adult member and are not available to other borrower categories.]]

[[R106 The platform shall record the lending library, the date by which the item must be returned to it and any conditions it sets, such as use in the library only.]]

## 11. Returns, reminders and charges

### 11.1 Returning items

[[R107 You can return items to any branch, to either mobile library, or through the returns chute of any branch when it is closed.]]

[[R108 Items returned through a chute while the branch is closed are treated as returned on the last day the branch was open.]]

[[R109 When an item with a note attached is returned, for example a note recording a missing disc, the platform shall show the note to the person or kiosk returning it.]]

### 11.2 Reminders and overdue notices

The current system sends overdue notices by email only, and sends nothing before an item is due. Members in the listening sessions asked for a reminder before the due date, and staff asked that members without email are not left out.

[[R110 You will receive a reminder three days before an item is due, by email, text message or both, as you have chosen.]]

[[R111 Overdue notices are sent by email or text message 7, 14 and 28 days after the due date.]]

[[R112 Members who have neither an email address nor a mobile number are sent the 28-day notice by post.]]

[[R113 After 42 days, an item still on loan shall be marked as lost, and the member shall be sent a bill for its replacement charge.]]

### 11.3 Overdue charges

Cabinet agreed in the summer to withdraw adult overdue charges, following other library services that found charges deterred the members who most needed the library while raising little money. Charges on children's and teenage items were withdrawn some years ago.

[[R114 From the day the new platform goes live, the library is fine-free for every member: no charge is made for returning any item late.]]

[[R115 Overdue charges on members' accounts at the date of migration are written off.]]

[[R116 Replacement charges for lost and damaged items continue to apply.]]

### 11.4 Lost and damaged items

[[R117 The replacement charge for an item shall be its catalogue price or, where no price is held, a standard charge for its item type set by stock and systems staff.]]

[[R118 If you return an item you have been billed for as lost within six months of the bill, the replacement charge will be refunded to you in full by the method you used to pay.]]

[[R119 As a branch supervisor, you must be able to waive or reduce a charge, recording your reason, and a waiver of more than 50 must be approved by a library manager.]]

[[R120 Children shall not be asked to pay for items they have lost or damaged, except in exceptional circumstances.]]

### 11.5 Blocks on an account

[[R121 A member's account shall be blocked from borrowing physical items when the member owes more than 10 in charges or has an item that is more than 28 days overdue.]]

[[R122 When your account is blocked, you will still be able to return items, pay charges, use the public computers and borrow e-books.]]

[[R123 You must be able to lift a block for a single visit, recording your reason.]]

## 12. Payments

Charges are now a small part of the service's income, and will be smaller still once overdue charges end, but members still pay replacement charges, replacement card charges, printing and photocopying, and the hire of some items in the music collection.

[[R124 You can pay charges online, at a kiosk or at the counter by card, and at the counter in cash.]]

[[R125 Every card payment shall be taken through the council's payment gateway, and the platform shall never see or store a full card number.]]

[[R126 The platform shall send Finance a daily file of payments and refunds by branch and by charge type, which balances to the payment gateway's own daily total.]]

[[R127 Overdue charges on DVDs borrowed by Adult members accrue at 1.00 a day, up to a maximum of 7.00 for each item, and are shown on the member's account as they accrue.]]

[[R128 Refunds are made only to the card used to pay, or in cash at the counter when the payment was made in cash.]]

[[R129 You will receive an email receipt for every payment you make online or at a kiosk.]]

[[R130 At the counter, you must be able to take a part payment of a charge and leave the remainder on the member's account.]]

## 13. E-lending

E-books and e-audiobooks are the fastest-growing part of the service. Members borrow them through the e-lending supplier's app, which today asks for the card number and PIN and checks them against the current system each time. The supplier holds the titles, the licences and the loans; the platform's part is to confirm who may borrow, to show e-lending titles alongside physical ones and to show members their e-loans.

[[R131 You will be able to borrow, reserve and return e-books and e-audiobooks from your library account, without a separate sign-in to the e-lending supplier's app.]]

[[R132 The platform shall confirm to the e-lending supplier's service, each time a member signs in to it, that the member's card is valid and which borrower category the member belongs to.]]

[[R133 E-loans count separately from physical loans: a member may hold up to 10 e-loans at once, whatever their borrower category.]]

[[R134 E-loans are returned automatically at the end of the loan period, and no reminder or overdue notice is sent for them.]]

[[R135 You will see your e-loans and e-reservations on the same account page as your physical loans and reservations.]]

[[R136 The pages of the platform that show e-lending titles shall meet the accessibility requirements in section 20 as far as possible.]]

[[R137 The platform shall show the number of licences still available for an e-lending title, where the supplier's service provides it.]]

## 14. Home library service and mobile libraries

### 14.1 Home library service

The home library service delivers to around 640 members in their own homes and in sheltered housing, using 45 volunteers. Volunteers choose items for each member from what the member has said they like, deliver them every four weeks and collect the previous delivery. Today the coordinator keeps each member's preferences on paper cards and the volunteers record loans on paper slips that staff key in afterwards.

[[R138 As the home library service coordinator, you must be able to record each member's reading preferences, the authors and subjects they do not want, the formats they need, such as large print or audio, and the titles they have already read.]]

[[R139 The platform shall warn a volunteer selecting items for a home library member when an item has been lent to that member before.]]

[[R140 You must be able to plan delivery rounds, allocating members to volunteers and to a four-weekly delivery date, and to print each volunteer's round sheet.]]

[[R141 Volunteers are given access only to the details of the members on their own round, and only on the day of the delivery and the day after it.]]

[[R142 Home library members do not receive overdue notices or replacement charge bills; an item that cannot be found is written off by the coordinator.]]

[[R143 As a volunteer, you will record the items you deliver and collect on a phone or tablet at the member's home, and the loans and returns will be recorded on the member's account.]]

[[R144 The platform shall let the coordinator record that a home library member is temporarily away, for example in hospital, so that no delivery is planned for them until they return.]]

### 14.2 Mobile libraries

The two mobile libraries each visit around 45 stops on a fortnightly timetable. Each vehicle carries around 3,000 items and a laptop with a barcode scanner. The vehicles have a mobile data connection that works at fewer than half of the stops, so the crews work offline and upload the day's transactions when they return to the depot.

[[R145 The mobile library laptops shall work offline for the whole of a day's route, lending, returning and renewing items and joining new members, and shall send the day's transactions to the platform when they next connect.]]

[[R146 Joining on a mobile library while offline creates a provisional record, which is checked for duplicates when the laptop next connects.]]

[[R147 You can choose a mobile library stop as your pickup location, and your reserved item will be held on the vehicle for its next two visits to that stop.]]

[[R148 The platform shall hold each mobile library's timetable of stops and shall use it to set due dates, so that an item borrowed on a mobile library falls due on a day the vehicle visits the stop where it was borrowed.]]

[[R149 As a mobile library crew member, you must be able to see, before setting off, the reservations waiting to be delivered to each stop on the day's route.]]

## 15. Extended-hours access and public computers

### 15.1 Extended-hours access

Four branches open for extended hours, from 8 in the morning to 8 in the evening, every day, with staff present for only part of that time. Members enter with their card and PIN at the door, which is controlled by the building management system. [[R216 The platform is responsible for deciding who may enter.]]

[[R150 You can apply for an extended-hours enrolment if you are an Adult member and have held your membership for at least a month, by attending a short induction at the branch.]]

[[R151 The platform shall send the building management system the list of members with a valid extended-hours enrolment for each branch, and shall send each change within five minutes of an enrolment being granted, suspended or withdrawn.]]

[[R152 An extended-hours enrolment is suspended automatically while the member's account is blocked.]]

[[R153 As a branch supervisor, you must be able to suspend or withdraw a member's extended-hours enrolment, recording your reason, and the member will be told why.]]

[[R154 The platform shall keep, for 30 days, a record of each entry to an extended-hours branch received from the building management system.]]

### 15.2 Public computers

Every branch has public computers, from four in the smallest to sixty at the central library. They are among the most used services in the library, especially by people looking for work, people claiming benefits and children doing homework.

[[R155 You can book a public computer at any branch up to seven days ahead, online or at the counter, for up to two hours a day.]]

[[R156 You will sign in to a public computer with your card number and PIN.]]

[[R157 Visitors who are not members are given a one-hour guest pass by staff, and no personal details are recorded for it.]]

[[R158 Junior members' sessions shall use the filtered internet profile, and Teen and Adult members' sessions shall use the standard profile.]]

[[R159 The platform shall release a booked computer to walk-in users if the member who booked it has not signed in within ten minutes of the start of the booking.]]

[[R160 Printing from the public computers is charged by the page to the member's account, and a print job is released only when the member pays at the print station or a kiosk.]]

## 16. Notifications and communications

Members and staff both said that the library's messages are hard to understand and arrive at the wrong time or not at all. Teenagers told the listening sessions that they did not want library messages going to a parent.

[[R161 You can choose to receive notices by email, by text message, by both, or by post if you have neither an email address nor a mobile number.]]

[[R162 You can choose which kinds of message you receive, apart from overdue notices and bills, which are always sent.]]

[[R163 The platform shall send every message from the library's own email address and telephone number, and a text message shall never contain more about a loan than its title and due date.]]

[[R164 Members aged 13 and over can join online without a responsible adult, and can choose their own contact details and notification preferences.]]

[[R165 Newsletters and event announcements are sent only to members who have opted in to them, and every one carries a link to opt out.]]

[[R166 As a member of stock and systems staff, you must be able to edit the wording of every notice the platform sends and preview it before it is used.]]

[[R167 The platform shall record every notice sent to a member, with its date, its channel and whether it was delivered, and shall show this record to branch staff.]]

## 17. Staff administration

### 17.1 Staff roles and access

Around 180 staff and 45 volunteers will use the platform. Today every member of staff can see and change every member's record, which the Information Governance team has asked the service to stop.

[[R168 The platform shall give each member of staff a role that sets what they can see and do, and stock and systems staff shall be able to create and change roles without the supplier's help.]]

[[R169 Staff sign in with the council's single sign-on, and a staff account is disabled automatically when the person leaves the council.]]

[[R170 The platform shall record every time a member of staff views a member's record, and Information Governance officers shall be able to see who viewed a given record and when.]]

[[R171 As a member of branch staff, you will see only the details you need to serve a member; their date of birth and address are hidden until you choose to show them, and showing them is recorded.]]

### 17.2 Branches, opening hours and closures

[[R172 You must be able to record each branch's opening hours and planned closures, such as bank holidays, up to eighteen months ahead, and the platform shall use them to set due dates.]]

[[R173 When a branch closes unexpectedly, for example because of a heating failure, you must be able to record the closure on the day, and items due back at that branch on the days it is closed shall have their due dates moved to its next opening day.]]

### 17.3 Stock movements

Stock is bought and catalogued in the stock acquisition system, which is out of scope. Once an item reaches a branch, its movements and its withdrawal are recorded in the platform.

[[R174 Stock and systems staff shall be able to move groups of items between branches as part of stock rotation, and the platform shall update each item's home branch when it arrives.]]

[[R175 Items that have not been borrowed for two years are listed each quarter for their branch to consider withdrawing them.]]

[[R176 The platform shall tell the council's stock acquisition system about the withdrawal of each item, so that its catalogue record can be updated.]]

## 18. Reports

The Libraries Board receives a quarterly report on membership and use, and branch managers want to see how their branch is doing without asking the central library for an extract. The service also completes the national annual statistics return for public libraries.

[[R177 The platform shall produce the Libraries Board's quarterly report without manual work, showing active members, new members, loans, renewals, reservations and computer sessions, each by branch, by borrower category and by ward.]]

[[R178 Reports for library managers shall be available in near real time.]]

[[R179 As a library manager, you must be able to build your own report from the platform's data, filter it and export it as a spreadsheet.]]

[[R180 Figures for the national annual statistics return are produced from the platform using the return's own definitions.]]

[[R181 No report shall show a member's name, card number or address unless the user's role allows it, and a report by ward shall suppress any figure below five.]]

## 19. Data protection and retention

The council is the controller of members' personal information. The current system keeps every loan ever made, linked to the member who made it, which the Information Governance team regards as far longer than the service needs.

[[R182 The platform shall hold members' personal information only in data centres in the UK.]]

[[R183 A member's record shall be deleted 18 months after the member's last activity, unless the member still has items on loan or owes charges.]]

[[R184 The link between a returned loan and the member who borrowed it shall be removed once the item has been returned and any charge paid, except for members who keep a borrowing history.]] [[A26 The period for which the link should be kept after return, for example so that damage found after an item comes back can be traced to the borrower, is to be confirmed by the Information Governance team.]]

[[R185 You can ask for a copy of the information the library holds about you, and Information Governance officers must be able to produce it from the platform in a single export.]]

[[R186 You can ask for your borrowing history to be deleted at any time, and it will be deleted within one working day.]]

[[R187 Answers to equality monitoring questions are kept apart from the member's record and are used only in reports in which no member can be identified.]]

## 20. Accessibility

Members who are blind or partially sighted, members with learning disabilities and older members took part in the listening sessions. All of them found the current catalogue hard or impossible to use.

[[R188 Every page that members use shall meet the Web Content Accessibility Guidelines version 2.2 at level AA.]]

[[R189 You will be able to use the whole of your account, the catalogue and the joining form with a screen reader, and with the keyboard alone.]]

[[R190 Kiosks are given audio guidance and a large-text mode, which a member can switch on at the start of a session.]]

[[R191 You can ask for any notice to be sent to you in large print or another format, and your choice will be remembered for every future notice.]]

[[R192 The platform shall be tested for accessibility by disabled users, including members who took part in the listening sessions, before it goes live.]]

## 21. Non-functional requirements

[[R193 The pages that members use shall be available 99.5 per cent of the time in each month, outside maintenance windows agreed with the council.]]

[[R194 95 per cent of catalogue searches shall return results within two seconds.]]

[[R195 The platform shall support 2,000 members signed in at once and 300 loans or returns a minute across all branches, kiosks and mobile libraries.]]

[[R196 Maintenance that makes the platform unavailable shall be done outside branch opening hours, and members shall be told about it at least three days ahead.]]

[[R197 All data shall be backed up daily, and the platform shall be restorable to its state no more than one hour before a failure.]]

[[R198 Members' PINs are stored only in a form from which they cannot be read back.]]

## 22. Migration from the current system

The current system holds around 210,000 member records, of which about 61,000 are active, along with 95,000 current loans, 14,000 open reservations and 8,000 outstanding charges. It uses four-digit PINs, which most members have had for many years.

[[R199 Every member record, current loan, open reservation and outstanding charge in the current system shall be migrated, and each reservation shall keep its place in its queue.]]

[[R200 Each member's loan history for the last two years shall be migrated, so that members can see what they borrowed before the change.]]

[[R201 Members are not asked to register again or to choose a new PIN: their existing card numbers and PINs continue to work.]]

[[R202 Duplicate records shall be identified during migration and listed for branch supervisors, but shall not be merged automatically.]]

[[R203 A trial migration is run at least twice before go-live, and each time the counts of members, loans, reservations and charges are reconciled with the current system.]]

[[R204 During the cut-over, you must be able to lend and return items offline at the counter for up to two days, and those transactions shall be loaded into the platform when it goes live.]]

## 23. Assumptions and open issues

### 23.1 Assumptions

- The council's customer identity service can tell the platform a resident's verified name, date of birth and address when they sign in.
- The council's payment gateway can be used by the kiosks as well as online.
- The e-lending supplier's service can accept a check of a member's card from the platform in place of the current system.
- The building management system for extended-hours branches can accept a list of enrolled members from the platform.
- The existing kiosks use the standard self-service protocol and will not need to be replaced.

### 23.2 Open issues

- [[A21 The Libraries Board has not yet decided whether to charge for inter-library requests, which cost the service around 9 each to obtain.]]
- [[A28 Whether Institutional members may place reservations is not covered by the lending policy, and the Libraries Board will decide before go-live.]]
- Whether a PIN is needed to borrow at a kiosk is still open; see section 5.2.
- The Information Governance team is reviewing how long the link between a returned loan and its borrower is kept; see section 19.

## Appendix A. Entitlements by borrower category

This table summarises section 6 for quick reference by branch staff.

| Borrower category | Items on loan | Reservations open | DVDs |
|---|---|---|---|
| Adult | [[A9 15 items, of which up to 4 DVDs]] | 15 | Yes |
| Teen | 12 items | 8 | Yes, except 18 certificate |
| Junior | 12 items | 5 | U and PG only |
| Restricted | 3 items | 3 | No |
| Home library service | 30 items | Not applicable | Yes |
| Institutional | 60 items | Not stated | Yes |

## Appendix B. Notification schedule

| Message | When it is sent | How it is sent |
|---|---|---|
| Welcome | Within five minutes of joining online | Email or text message |
| Due-date reminder | Three days before the due date | Email, text message or both |
| Reservation ready | When the item reaches the hold shelf | Preferred contact method |
| Reservation about to expire | [[A15 Two days before the end of the ten-day collection period]] | Preferred contact method |
| Overdue notices | 7, 14 and 28 days after the due date | Email or text message; the 28-day notice by post if neither is held |
| Lost item bill | 42 days after the due date | Email, text message or post |
| Membership closing | One month before closure for inactivity | Preferred contact method |

## Appendix C. Reading groups and the summer reading scheme

Two services lend in ways that do not fit the borrower categories in section 6. The rules below come from the terms of each service. The general requirements in sections 4 to 16 apply to both unless this appendix says otherwise.

### C.1 Reading group sets

The service lends sets of eight to fifteen copies of the same title to around 120 reading groups that meet in homes, cafes, workplaces and branches. Sets are kept at the central library and booked months ahead. Each group has a named organiser, who must be an Adult member.

[[R205 As a reading group organiser, you can book up to three sets at a time, for a loan period of six weeks each, choosing from the list of sets the library publishes.]]

[[R206 A reading group set is lent to the organiser's card as a single loan, and the platform shall record how many copies the set contains when it is lent and when it comes back.]]

[[R207 If a set comes back with copies missing, the organiser is asked to return them within four weeks before any replacement charge is made.]]

[[R208 The platform shall show each set's calendar of bookings, so that you can see when a set is next free before you book it.]]

[[R209 Sets that are booked by a reading group are not counted against the organiser's own entitlement to borrow.]]

### C.2 The summer reading scheme

Every summer the library runs a reading scheme for children aged 4 to 11. Children join the scheme in a branch, read at least six books over the holidays and collect a sticker for each book they talk about with a member of staff or volunteer. Last year around 6,800 children took part. Today their progress is recorded on paper record cards, and many children lose them before the end of the summer.

[[R210 A child taking part in the summer reading scheme shall be able to have their progress recorded against their library account, so that it is not lost if the paper card is.]]

[[R211 As a member of branch staff or a volunteer, you must be able to record a book a child has read for the scheme in no more than two steps, by scanning the child's card and then the book or choosing it from the child's recent loans.]]

[[R212 Children who join the library in order to take part in the scheme are counted separately in the reports, so that the service can see how many new members the scheme brings in.]]

[[R213 A responsible adult will be able to see their child's progress in the scheme from their own account.]]

[[R214 At the end of the scheme, the platform shall produce a list of the children who completed it at each branch, for the certificates that are presented in September.]]

## Appendix D. Worked examples

These examples show how the requirements are meant to work together. They are not requirements in themselves.

### D.1 A family joins at a rhyme time session

A parent who already holds an Adult membership brings her three-year-old to a rhyme time session at a smaller branch and asks to join him. The library assistant registers the child on a single screen, links the child's account to the mother's and gives the child a physical card. No proof of address is asked for, because the mother is already a member. The mother sees her son's card number on her own account the same day and, a week later, renews the picture books he borrowed from her phone. When the boy turns 12, his account moves to the Teen category, and both he and his mother are told a week before.

### D.2 A member reserves a title held at another branch

A member who lives near one of the branches open three days a week finds a novel in the catalogue. The only copy on the shelf is at the central library. She places a reservation and chooses her local branch as the pickup location. The copy goes on the next van run and reaches her branch two days later. She is told the item is ready to collect and, when she has not collected it by the fifth day, she receives a reminder. She collects it on the sixth day and borrows it at the kiosk.

### D.3 A member returns an item late

A member returns a novel three weeks after its due date. He had received a reminder three days before the due date and overdue notices after 7 and 14 days. Nothing is charged, and the notices stop as soon as the novel is returned. Had he kept it for 42 days, it would have been marked as lost and he would have been sent a bill for its replacement charge, which would have been refunded in full if he had returned the novel within six months of the bill.

### D.4 A housebound member's delivery

A home library member who uses large print tells the coordinator that she has gone off crime novels. The coordinator updates her preferences. When her volunteer next selects items for her, the platform warns him that one of the large print titles he has chosen was lent to her last year. He chooses another, delivers six books on the planned date and collects the previous delivery, recording both on his tablet before he leaves.

### D.5 A branch closes for a week

A heating failure closes one of the smaller branches without warning on a Tuesday. The branch supervisor records the closure that morning. Items due back at the branch that week have their due dates moved to the Tuesday after it reopens, and members with reservations waiting there are offered another pickup location. The extended-hours door is not affected, because the branch is not one of the four that open for extended hours.

### D.6 A reservation collected from a mobile library

A retired farmer who lives in one of the villages on the eastern mobile library route reserves an audiobook and chooses his village stop as the pickup location. Before setting off on the next visit to that stop, the crew sees the reservation on the day's list and loads the audiobook onto the vehicle. He is away that day, so the audiobook stays on the vehicle and he collects it a fortnight later, on the second visit. The laptop has no signal at his stop, so the loan is recorded offline and sent to the platform when the vehicle returns to the depot that evening. The due date falls on a day the vehicle is timetabled to visit his village.

### D.7 A resident without a fixed address

A man staying in a hostel asks to join so that he can use the computers to look for work. He has no proof of address. The branch supervisor gives him a Restricted membership, which lets him book a public computer, borrow up to three books and use e-lending. He signs in to a computer with his new card number and PIN the same afternoon. Three months later he moves into a flat, brings a tenancy agreement and a utility bill to the counter, and his membership is changed to an Adult membership, keeping the same card number and loans.

### D.8 Renewing a mixed set of loans

A member has eleven items on loan: nine novels, a DVD and a reading lamp. Two days before they are due, the platform renews them automatically. Eight of the novels and the DVD are renewed. The ninth novel is not, because another member has reserved it, and the reading lamp is not, because equipment cannot be renewed. The member receives one message listing the nine items that were renewed with their new due dates, and the two that were not, each with the reason. She returns the reserved novel and the lamp to her local branch that week; the lamp goes back on the van to the branch she borrowed it from.

<!-- labels
A1 [tbd] @R37: whether a PIN is required to borrow at a kiosk, or the card alone is enough, is left to the Libraries Board => Must members enter a PIN to borrow at a kiosk, or is scanning the card enough?
A2 [undefined-term] @R17: a "trusted referee" may vouch for identity and address, but the document never says who counts as one => Who counts as a trusted referee, and what must their letter say?
A3 [conflict] @R21,R164: section 4.5 says a child under 16 can only join with a responsible adult's consent, while section 16 lets members aged 13 and over join online without one => Can a 13 to 15 year old join online without a responsible adult, and if so is anyone linked to their account?
A4 [missing] @R27,R26: Visitor members get "the entitlements set out in section 6 for their borrower category", but neither section 6 nor Appendix A lists a Visitor category or says which category a visitor joins => What may a Visitor member borrow and reserve, and which borrower category do they belong to?
A5 [conflict] @R40,R200: a borrowing history is kept only for members who opt in and is off by default, yet migration brings over two years of loan history for every member => Is the migrated loan history kept for members who have not opted in, and are members asked first?
A6 [conflict] @R45,R183: section 5.4 deletes a record three and a half years after the last activity, section 19 after 18 months => After how long without activity is a member's record deleted, and is the member reminded first in both cases?
A7 [vague-term] @R49: duplicates "are to be resolved quickly once they have been identified", with no time or owner => Within what time must a branch supervisor resolve a possible duplicate, and what happens if they do not?
A8 [conflict] @R75,R83: the loan-period table lets books be renewed up to five times, while section 9 allows any item three renewals => How many times can a book be renewed: three or five?
A9 [conflict] @R50: Appendix A gives Adults 15 items on loan, while section 6 gives them 20 => Is the Adult loan limit 15 or 20 items?
A10 [undefined-term] @R76: "high-demand titles" are lent for one week and cannot be renewed, but nothing says what makes a title high-demand or who decides => What makes a title high-demand, who marks it, and does the mark come off when demand falls?
A11 [vague-term] @R69: kiosks must be "easy to use for older members and for members who have never used one before", with no measure => How will ease of use be tested on the kiosks, and with whom?
A12 [escape-clause] @R70: kiosks take contactless payments only "where the branch's equipment allows" => Which kiosks will take contactless payments at go-live, and who pays for any new equipment?
A13 [undefined-term] @R93: reservations by "priority members" jump the queue, but the term is not defined and no category carries it => Who are priority members, and how is a member given that status?
A14 [vague-term] @R96: members are told "promptly" when a reservation is ready, and Appendix B gives no time either => Within what time of an item reaching the hold shelf must the member be told?
A15 [conflict] @R97,R98: section 10.3 keeps reserved items on the hold shelf for seven days, while Appendix B speaks of a ten-day collection period => Is a reserved item kept for seven days or ten, and are these calendar days or opening days?
A16 [escape-clause] @R101: items should arrive within three working days "unless this is operationally impractical" => When may a transfer take longer than three working days, and is the member told?
A17 [undefined-term] @R103: members of a closing branch are given "the standard notice period", which the document never defines => What is the standard notice period for moving reservations from a branch that is closing temporarily?
A18 [missing] @R110,R111,R112: members with neither email nor mobile get only the 28-day notice by post; nothing says whether they get the due-date reminder or the 7 and 14-day notices => Do members without email or a mobile number get a due-date reminder and the earlier overdue notices, and by what channel?
A19 [conflict] @R114,R127: section 11.3 makes the library fine-free for every member, while section 12 charges adults 1.00 a day for overdue DVDs => Are overdue DVD charges abolished with the rest, or do they remain?
A20 [escape-clause] @R120: children are not asked to pay for lost or damaged items "except in exceptional circumstances" => What circumstances justify charging a child, and who decides?
A21 [tbd] @R105: whether inter-library requests are charged for is undecided => Will members be charged for inter-library requests, and how much?
A22 [escape-clause] @R136: e-lending pages need meet the accessibility requirements only "as far as possible" => Which e-lending pages may fall short of WCAG 2.2 AA, and what is the fallback for screen reader users?
A23 [missing] @R131,R47: nothing says what happens to the member's e-loans, e-reservations or the supplier's copy of their details when a membership is closed or deleted => When a membership is closed or deleted, are its e-loans ended and is the e-lending supplier told to delete its record?
A24 [missing] @R143,R145: the mobile library laptops must work offline, but nothing says whether the volunteers' phones or tablets must, though many homes have no signal => Must home library volunteers be able to record deliveries offline?
A25 [vague-term] @R178: reports must be available "in near real time" => How current must manager reports be: minutes, hours or the previous night?
A26 [tbd] @R184: how long the link between a returned loan and its borrower is kept has not been set => How long after return may the platform keep the link between a loan and its borrower?
A27 [conflict] @R34,R201: new PINs must be at least six digits, yet migrated members keep their existing four-digit PINs => Will four-digit PINs keep working after migration, and if not, how and when are members moved to six digits?
A28 [tbd] @R57: whether Institutional members may reserve is undecided, and Appendix A says "Not stated" => May Institutional members place reservations, and how many?
A29 [conflict] @R141,R139: volunteers select items beforehand but can only access member details on delivery day and the day after => How can volunteers select items before the delivery day?
A30 [undefined-term] @R119: library manager is not in the users list and the role is undefined => Which role is a library manager, and how does it map to platform roles?
-->
