package models

import (
	"database/sql"

	"gorm.io/gorm"
)

// FindAllUsers reads via a GORM Model() chain -> reads edge to `users`.
func FindAllUsers(db *gorm.DB) []User {
	var users []User
	db.Model(&User{}).Where("age > ?", 18).Find(&users)
	return users
}

// CreateUser writes via a composite-literal Create -> writes edge to `users`.
func CreateUser(db *gorm.DB, name string) {
	db.Create(&User{Name: name})
}

// RenameUser writes via a Model().Update chain -> writes edge to `users`.
func RenameUser(db *gorm.DB, id uint, name string) {
	db.Model(&User{}).Where("id = ?", id).Update("full_name", name)
}

// DeleteCard writes via a Delete on a slice type -> writes edge to `credit_cards`.
func DeleteCard(db *gorm.DB, id uint) {
	db.Delete(&CreditCard{}, id)
}

// FindProfiles reads a TableName()-overridden model -> reads `account_profiles`.
func FindProfiles(db *gorm.DB) []Profile {
	var profiles []Profile
	db.Model(&Profile{}).Find(&profiles)
	return profiles
}

// FindByTable uses an explicit .Table("...") literal -> reads `users`.
func FindByTable(db *gorm.DB) {
	var users []User
	db.Table("users").Where("age > ?", 21).Find(&users)
}

// RawSql uses database/sql raw string SQL — covered by the sqlglot embedded-SQL
// path (Step 6), NOT the GORM resolver. Present here to document the split.
func RawSql(db *sql.DB) (*sql.Rows, error) {
	return db.Query("SELECT id, full_name FROM users WHERE age > 18")
}
