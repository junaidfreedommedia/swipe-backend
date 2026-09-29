import {
  Divider,
  Image,
  Link,
  Modal,
  Icon,
  BlockLayout,
  View,
  Style,
  Text,
  Grid,
} from "@shopify/ui-extensions-react/checkout";

function InfoModal() {
  return (
    <Link
      overlay={
        <Modal padding title="&nbsp;">
          <BlockLayout rows={["auto", "auto", "auto", "auto", "auto"]}>
  

            {/* (2) Your full‐size modal image */}
            <View display="inline" blockAlignment="center" inlineAlignment="center"  padding={["none", "none", "none", "none"]}
>
              <Image
                source={Style
                  .default("https://swipe-images-01.s3.us-east-1.amazonaws.com/swipe-info-popup.png")
                  .when(
                    { viewportInlineSize: { min: "large" } },
                    "https://swipe-images-01.s3.us-east-1.amazonaws.com/swipe-info-popup.png"
                  )}
                alt="Swipe Protection Info"
              />
            </View>

            {/* (3) Divider */}
            <Divider />

            {/* (4) Agreement text (vertical padding only, zero horizontal) */}
            <View
              display="inline"
              blockAlignment="center"
              inlineAlignment="center"
              padding={["base", "none", "none", "none"]}
              style={{ paddingLeft: 0, paddingRight: 0 }}
            >
              <Text appearance="subdued" size="small" blockAlignment="center">
                By adding Swipe Protection, you agree to our Terms & Policies:
              </Text>
            </View>

            {/* (5) Footer links (zero padding all round) */}
            <View
              display="inline"
              blockAlignment="center"
              inlineAlignment="center"
                            padding={["none", "none", "none", "none"]}

            >
              <Grid
                columns={["auto", "auto", "auto"]}
                spacing="extraLoose"
                blockAlignment="center"
                inlineAlignment="center"
              >
                <Link to="https://swipe.ai/file-a-claim">
                  <Text appearance="subdued" size="small">
                    File A Claim
                  </Text>
                </Link>
                <Link to="https://swipe.ai/privacy-policy">
                  <Text appearance="subdued" size="small">
                    Policies
                  </Text>
                </Link>
                <Link to="https://swipe.ai/terms-and-conditions">
                  <Text appearance="subdued" size="small">
                    Terms of Services
                  </Text>
                </Link>
              </Grid>
            </View>
          </BlockLayout>
        </Modal>
      }
    >
      <Icon source="question" size="base" appearance="info" />
    </Link>
  );
}

export default InfoModal;
