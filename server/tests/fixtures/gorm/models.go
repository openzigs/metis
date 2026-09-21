package models

import "gorm.io/gorm"

// User is a GORM model mapped to the default pluralized table `users`.
type User struct {
	gorm.Model
	Name  string `gorm:"column:full_name"`
	Email string
	Age   int
	Notes string `gorm:"-"`
}

// CreditCard exercises multi-word snake_case pluralization -> `credit_cards`.
type CreditCard struct {
	ID     uint
	Number string
	UserID uint
}

// Profile overrides its table name via the GORM TableName() hook.
type Profile struct {
	ID  uint
	Bio string
}

// TableName maps Profile to the physical `account_profiles` table.
func (Profile) TableName() string {
	return "account_profiles"
}
