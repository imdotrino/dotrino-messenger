import XCTest

/// THE WHOLE ROUND against the production PWA: this phone redeems the code of a web user
/// (`TEST_RUNNER_PWA_CODE`), the web accepts, the phone writes and waits for the reply. Driven
/// from the other side by a Playwright script. Skipped without the code.
final class RoundTripUITests: XCTestCase {
    func testRequestThenMessagesBothWays() throws {
        guard let code = ProcessInfo.processInfo.environment["PWA_CODE"] else { throw XCTSkip("set TEST_RUNNER_PWA_CODE") }
        let app = XCUIApplication()
        app.launch()
        let nick = app.textFields["nickname-input"]
        if nick.waitForExistence(timeout: 20) {
            nick.tap(); nick.typeText("Eva_iOS")
            app.buttons["nickname-submit"].tap()
        }
        XCTAssertTrue(app.buttons["add-contact"].waitForExistence(timeout: 30))
        app.buttons["add-contact"].tap()
        let field = app.textFields["code-input"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText(code)
        app.buttons["send-hello"].tap()
        // The web accepts; the contact appears here (not before).
        let contact = app.buttons["contact-item"].firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 120), "the web did not accept")
        contact.tap()
        let composer = app.textFields["composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText("hola desde ios")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["hola ios, te leo desde la web"].waitForExistence(timeout: 120), "the web reply did not arrive")
    }
}
