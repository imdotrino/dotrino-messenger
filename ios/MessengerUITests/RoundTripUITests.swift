import XCTest

/// THE WHOLE ROUND against the production PWA: this phone redeems the code of a web user
/// (`TEST_RUNNER_PWA_CODE`), the web accepts, the phone writes and waits for the reply. Driven
/// from the other side by `smoke:native-messenger` of dotrino-test (`TEST_RUNNER_PWA_NICK` is the
/// web user's nickname). Skipped without the code.
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
        // The web accepts; the contact appears here (not before). By its name: the pinned Dotrino
        // contact is a contact-item too.
        let nickOfWeb = ProcessInfo.processInfo.environment["PWA_NICK"] ?? ""
        let contact = app.buttons.matching(identifier: "contact-item").matching(NSPredicate(format: "label CONTAINS %@", nickOfWeb)).firstMatch
        XCTAssertTrue(contact.waitForExistence(timeout: 120), "the web did not accept")
        contact.tap()
        // Multi-line (axis: .vertical): a text view, not a text field.
        let composer = app.descendants(matching: .any).matching(identifier: "composer-input").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText("hola desde ios")
        app.buttons["send-message"].tap()
        XCTAssertTrue(app.staticTexts["hola ios, te leo desde la web"].waitForExistence(timeout: 120), "the web reply did not arrive")
    }
}
