const userInput = req.body.username;
const sql = "SELECT * FROM users WHERE username = '" + userInput + "'";
db.query(sql);
document.getElementById('root').innerHTML = userInput;
